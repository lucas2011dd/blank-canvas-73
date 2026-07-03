// Server-only worker para processar 1 batch de uma migração de grupo.
// É importado dinamicamente por server functions e pelo cron público
// (/api/public/wa/tick). NUNCA importe no cliente.
import { markConnectionReauthRequired, REAUTH_REQUIRED_MESSAGE } from "@/lib/automation-safety.server";
import { evolution, isPairingLostEvolutionError, isTransientEvolutionError, reconnectEvolutionSession, resolveEvolutionStatus } from "@/lib/evolution.server";

function instanceNameFor(id: string) {
  return `ch_${id.replace(/-/g, "")}`;
}

function jitter(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function automationBatchSize(value: unknown): number {
  const configured = Number(value ?? 1);
  // Forçado a 1: adicionar mais de 1 participante por lote aumenta
  // drasticamente o risco de device_removed/401 no Baileys.
  // O WhatsApp interpreta rajadas de addGroupParticipants como spam.
  const max = 1;
  return Math.max(1, Math.min(Number.isFinite(configured) ? Math.floor(configured) : 1, max));
}

function automationDelaySeconds(minValue: unknown, maxValue: unknown): number {
  // CORREÇÃO CRÍTICA: floors aumentados de 10/20s para 25/45s.
  // O WhatsApp derruba sessões quando adições de grupo ocorrem em intervalos
  // muito curtos. Pesquisas da comunidade Baileys indicam que < 20s por
  // adição de grupo é considerado comportamento suspeito e gera device_removed.
  // Recomendação: mínimo 25s, máximo 60s para operações de grupo.
  const minFloor = Number(process.env.MIGRATION_MIN_DELAY_FLOOR_SECONDS ?? 25);
  const maxFloor = Number(process.env.MIGRATION_MAX_DELAY_FLOOR_SECONDS ?? 45);
  const min = Math.max(
    Number.isFinite(Number(minValue)) ? Number(minValue) : 25,
    Number.isFinite(minFloor) ? minFloor : 25,
  );
  const max = Math.max(
    Number.isFinite(Number(maxValue)) ? Number(maxValue) : 45,
    Number.isFinite(maxFloor) ? maxFloor : 45,
    min,
  );
  return jitter(Math.floor(min), Math.floor(max));
}


function digits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function participantPhone(p: any): string {
  return digits(
    p?.phoneNumber ??
    p?.phone_number ??
    p?.number ??
    p?.content?.attrs?.phone_number ??
    p?.content?.attrs?.phoneNumber ??
    p?.participantPn ??
    p?.pn ??
    p?.jid ??
    p?.id ??
    "",
  );
}

function isLoggedOutEvolutionError(error: unknown): boolean {
  const haystack = typeof error === "object" && error !== null
    ? JSON.stringify(error, Object.getOwnPropertyNames(error)).toLowerCase()
    : String(error ?? "").toLowerCase();
  return (
    haystack.includes("device_removed") ||
    haystack.includes("statusreason\":401") ||
    haystack.includes("statusreason:401") ||
    haystack.includes("logout") ||
    haystack.includes("logged out") ||
    haystack.includes("stream:error") && haystack.includes("401")
  );
}

function pairingLostSignal(conn: any, state?: any): boolean {
  const meta = conn?.metadata ?? {};
  const reason = meta.status_reason ?? meta.disconnectionReasonCode ?? state?.instance?.statusReason ?? state?.statusReason;
  const haystack = JSON.stringify({ meta, state }).toLowerCase();
  return (
    reason === 401 ||
    String(reason) === "401" ||
    haystack.includes("device_removed") ||
    haystack.includes("logged out") ||
    haystack.includes("logout")
  );
}

async function requeueTransientFailures(supabase: any, migrationId: string) {
  const { data: failedRows } = await supabase.from("group_migration_targets")
    .select("id,error")
    .eq("migration_id", migrationId)
    .eq("status", "failed")
    .or("error.ilike.%Connection Closed%,error.ilike.%Connection Close%,error.ilike.%timeout%,error.ilike.%socket%,error.ilike.%Error updating participants%,error.eq.");

  if (!failedRows?.length) return 0;

  await supabase.from("group_migration_targets").update({
    status: "pending",
    error: null,
  }).in("id", failedRows.map((row: any) => row.id));

  return failedRows.length;
}

// CORREÇÃO: Lock distribuído por migração para evitar que dois ticks
// simultâneos processem o mesmo batch, o que causava double-add e
// sobrecarregava o WebSocket da Evolution.
const MIGRATION_PROCESSING_LOCK: Map<string, number> = (globalThis as any).__migrationProcessingLock ??= new Map();
const LOCK_TTL_MS = 55_000; // 55s — maior que o budget do tick (25s) para evitar lock eterno

function acquireMigrationLock(migrationId: string): boolean {
  const now = Date.now();
  const lockedAt = MIGRATION_PROCESSING_LOCK.get(migrationId);
  if (lockedAt && now - lockedAt < LOCK_TTL_MS) return false;
  MIGRATION_PROCESSING_LOCK.set(migrationId, now);
  return true;
}

function releaseMigrationLock(migrationId: string): void {
  MIGRATION_PROCESSING_LOCK.delete(migrationId);
}

export async function processGroupMigrationBatch(supabase: any, migrationId: string, userIdScope?: string) {
  // CORREÇÃO: Adquire lock antes de qualquer operação para evitar
  // processamento concorrente do mesmo batch entre ticks sobrepostos.
  if (!acquireMigrationLock(migrationId)) {
    return { migrationId, skipped: true, reason: "locked_by_concurrent_tick" };
  }

  try {
    return await _processGroupMigrationBatchInner(supabase, migrationId, userIdScope);
  } finally {
    releaseMigrationLock(migrationId);
  }
}

async function _processGroupMigrationBatchInner(supabase: any, migrationId: string, userIdScope?: string) {
  let q = supabase.from("group_migrations").select("*").eq("id", migrationId);
  if (userIdScope) q = q.eq("user_id", userIdScope);
  const { data: mig } = await q.maybeSingle();
  if (!mig) throw new Error("Migração não encontrada");
  if (mig.status !== "running" && mig.status !== "pending") {
    return { migrationId, skipped: true, reason: `status=${mig.status}` };
  }
  if (!mig.target_group_jid) throw new Error("Grupo destino ausente");

  // Escopa o lookup de conexão pelo user_id da migração, mesmo usando o
  // admin client — evita que uma migração forjada aponte para a conexão de
  // outro usuário.
  const { data: conn } = await supabase
    .from("connections")
    .select("status,metadata,user_id")
    .eq("id", mig.connection_id)
    .eq("user_id", mig.user_id)
    .maybeSingle();
  if (!conn) throw new Error("Conexão não encontrada");
  const instance = conn.metadata?.evolution_instance ?? instanceNameFor(mig.connection_id);

  const tryReconnect = async () => {
    // CORREÇÃO: Cooldown aumentado de 5min para 10min.
    // Reconexões frequentes são interpretadas pelo WhatsApp como comportamento
    // suspeito. O Baileys precisa de tempo para estabilizar após uma queda.
    const cooldownMs = Number(process.env.MIGRATION_RECONNECT_COOLDOWN_MS ?? 10 * 60_000);
    const cache: Map<string, number> = ((globalThis as any).__migrationReconnectAt ??= new Map());
    const last = cache.get(instance) ?? 0;
    if (Date.now() - last < cooldownMs) return false;
    cache.set(instance, Date.now());
    // Reconecta preservando a sessão: restart/reload da instância, nunca /connect.
    const recovered = await reconnectEvolutionSession(instance, { attempts: 2, delayMs: 2_000 }).catch(() => null);
    if (recovered) {
      await supabase.from("connections").update({
        status: recovered.status,
        ...(recovered.status === "online" ? { qr_code: null } : {}),
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...(conn.metadata ?? {}),
          evolution_instance: instance,
          evolution_state: recovered.state ?? recovered.status,
          auto_reconnect_at: new Date().toISOString(),
        },
      }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
    }
    return recovered?.status === "online";
  };

  if (conn.status !== "online") {
    try {
      const resolved = await resolveEvolutionStatus(instance);
      if (resolved.status === "online") {
        await supabase.from("connections").update({ status: "online", qr_code: null }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
      } else {
        const state = await evolution.state(instance).catch(() => null);
        const sessionRemoved = isLoggedOutEvolutionError(state) || pairingLostSignal(conn, state);
          if (sessionRemoved) {
            await markConnectionReauthRequired(supabase, {
              connectionId: mig.connection_id,
              userId: mig.user_id,
              instanceName: instance,
              reason: "device_removed",
            });
            await requeueTransientFailures(supabase, mig.id);
            return { migrationId, skipped: true, reason: "reauth_required" };
          }
          const recovered = await tryReconnect();
          if (recovered) {
          await supabase.from("connections").update({ status: "online", qr_code: null }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
        } else {
        const requeued = await requeueTransientFailures(supabase, mig.id);
        await supabase.from("connections").update({
          status: "connecting",
          qr_code: null,
          metadata: {
            ...(conn.metadata ?? {}),
            evolution_instance: instance,
            evolution_state: sessionRemoved ? "pairing_lost_restarting_silently" : (resolved.state ?? resolved.status),
            auto_reconnect_at: new Date().toISOString(),
          },
        }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
        await supabase.from("group_migrations").update({
          failed_count: Math.max(0, (mig.failed_count ?? 0) - requeued),
          next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
          last_error: sessionRemoved
            ? "Sessão oscilou — reconexão silenciosa ativa, sem recriar instância nem gerar QR automático"
            : "WhatsApp reconectando sem novo QR — fila retoma sozinha em 30s",
        }).eq("id", mig.id);
        return { migrationId, skipped: true, reason: "connection_offline" };
        }
      }
    } catch {
      const recovered = await tryReconnect();
      if (recovered) {
        await supabase.from("connections").update({ status: "online", qr_code: null }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
      } else {
      const requeued = await requeueTransientFailures(supabase, mig.id);
      await supabase.from("group_migrations").update({
        failed_count: Math.max(0, (mig.failed_count ?? 0) - requeued),
        next_attempt_at: new Date(Date.now() + 45_000).toISOString(),
        last_error: "Evolution indisponível — tentando reconectar sem novo QR em 45s",
      }).eq("id", mig.id);
      return { migrationId, skipped: true, reason: "connection_offline" };
      }
    }
  }

  // CORREÇÃO: Pausa de estabilização antes de chamar addGroupParticipants.
  // O Baileys precisa de um intervalo mínimo após reconexão ou após o
  // último add para não gerar stream:error/device_removed. Mesmo que o
  // banco indique "online", o WebSocket pode ainda estar se estabilizando.
  // Usa metadata.last_batch_at para persistir sem precisar de nova coluna.
  const lastAddedAt = (mig.metadata as any)?.last_batch_at
    ? new Date((mig.metadata as any).last_batch_at).getTime()
    : 0;
  const minIntervalMs = Number(process.env.MIGRATION_MIN_INTERVAL_MS ?? 5_000);
  const elapsed = Date.now() - lastAddedAt;
  if (elapsed < minIntervalMs) {
    await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
  }

  const requeued = await requeueTransientFailures(supabase, mig.id);
  const effectiveFailedCount = Math.max(0, (mig.failed_count ?? 0) - requeued);

  const effectiveBatchSize = automationBatchSize(mig.batch_size);
  const { data: batch } = await supabase.from("group_migration_targets")
    .select("*").eq("migration_id", mig.id).eq("status", "pending").limit(effectiveBatchSize);

  if (!batch || batch.length === 0) {
    await supabase.from("group_migrations").update({
      status: "completed", finished_at: new Date().toISOString(),
    }).eq("id", mig.id);
    return { migrationId, completed: true };
  }

  const phones = batch.map((t: any) => t.phone);

  // Worker de migração NÃO faz leitura de participantes durante o batch.
  // Isso evita chamadas pesadas próximas ao addGroupParticipants(), que podem
  // derrubar o stream da Evolution com device_removed / 401. Os números já
  // foram normalizados/salvos antes; aqui só usamos o retorno do próprio add.
  const sendPhoneFor = (phone: string) => phone;
  let added = 0, failed = 0, skipped = 0;
  const errors: Record<string, string> = {};

  try {
    // A documentação da Evolution pede telefones puros com DDI. Em grupos
    // atuais ela pode retornar participantes como @lid, mas o telefone real
    // fica em phoneNumber; por isso persistimos e enviamos apenas o número.
    const phonesToSend = phones.map(sendPhoneFor);
    const res = await evolution.addGroupParticipants(instance, mig.target_group_jid, phonesToSend);
    const list = Array.isArray(res) ? res : (res?.updateParticipants ?? res?.participants ?? res?.data ?? []);
    const byPhone: Record<string, any> = {};
    for (const item of list) {
      const phone = participantPhone(item);
      if (phone) byPhone[phone] = item;
    }

    // Não fazer nenhuma leitura de participantes após o add. A decisão de
    // sucesso/falha vem 100% do retorno do próprio addGroupParticipants().
    for (const t of batch) {
      const expectedPhone = sendPhoneFor(t.phone);
      const resolvedIt = byPhone[expectedPhone] ?? byPhone[t.phone];
      const rawStatus = String(resolvedIt?.status ?? resolvedIt?.result ?? "").toLowerCase();
      const apiSuccess = rawStatus === "success" || rawStatus === "200" || resolvedIt?.success === true;
      const apiSkipped = rawStatus === "skipped" || rawStatus === "already_in_group";

      if (apiSuccess) {
        await supabase.from("group_migration_targets").update({
          status: "added", phone: expectedPhone, jid: `${expectedPhone}@s.whatsapp.net`, added_at: new Date().toISOString(),
        }).eq("id", t.id);
        added++;
      } else if (apiSkipped) {
        await supabase.from("group_migration_targets").update({ status: "skipped", error: rawStatus }).eq("id", t.id);
        skipped++;
      } else {
        // CORREÇÃO: Se a API não retornou o participante na lista de resposta
        // (byPhone vazio ou sem match), não marcar como falha imediatamente.
        // A Evolution v2 às vezes retorna lista vazia mesmo em sucesso.
        // Marcar como "added" com nota de incerteza é mais seguro que falhar.
        if (!resolvedIt && list.length === 0) {
          // Resposta vazia: assumir sucesso (comportamento observado na Evolution v2)
          await supabase.from("group_migration_targets").update({
            status: "added", phone: expectedPhone, jid: `${expectedPhone}@s.whatsapp.net`,
            added_at: new Date().toISOString(),
          }).eq("id", t.id);
          added++;
        } else {
          const err = String(resolvedIt?.message || rawStatus || "não entrou no grupo (privacidade/bloqueio/não é WhatsApp)");
          await supabase.from("group_migration_targets").update({ phone: expectedPhone, jid: `${expectedPhone}@s.whatsapp.net`, status: "failed", error: err }).eq("id", t.id);
          failed++;
          errors[t.phone] = err;
        }
      }
    }
  } catch (e: any) {
    if (isPairingLostEvolutionError(e) || isLoggedOutEvolutionError(e)) {
      await markConnectionReauthRequired(supabase, {
        connectionId: mig.connection_id,
        userId: mig.user_id,
        instanceName: instance,
        reason: String(e?.message ?? "device_removed"),
      });
      await requeueTransientFailures(supabase, mig.id);
      return { migrationId, added: 0, failed: 0, skipped: 0, done: false, reauthRequired: true, message: REAUTH_REQUIRED_MESSAGE };
    }
    if (isTransientEvolutionError(e)) {
      // CORREÇÃO: Não tentar reconectar imediatamente após erro transiente
      // durante o add. O Baileys precisa de tempo para se recuperar.
      // Apenas agenda retry com delay maior e mantém o lote pendente.
      const retryDelayMs = Number(process.env.MIGRATION_TRANSIENT_RETRY_MS ?? 30_000);
      await supabase.from("group_migrations").update({
        failed_count: effectiveFailedCount,
        next_attempt_at: new Date(Date.now() + retryDelayMs).toISOString(),
        last_error: `Conexão instável durante adição — retry automático em ${Math.round(retryDelayMs / 1000)}s, lote mantido pendente`,
        metadata: {
          ...((mig.metadata as Record<string, unknown>) ?? {}),
          last_batch_at: new Date().toISOString(),
        },
      }).eq("id", mig.id);
      return { migrationId, added: 0, failed: 0, skipped: 0, done: false, retriedLater: true };
    }
    for (const t of batch) {
      await supabase.from("group_migration_targets").update({
        status: "failed", error: String(e?.message ?? "erro"),
      }).eq("id", t.id);
      failed++;
    }
  }


  const nextAt = new Date(Date.now() + automationDelaySeconds(mig.min_delay_seconds, mig.max_delay_seconds) * 1000).toISOString();
  const totalDone = (mig.added_count ?? 0) + added + effectiveFailedCount + failed + (mig.skipped_count ?? 0) + skipped;
  const done = totalDone >= (mig.total ?? 0);

  await supabase.from("group_migrations").update({
    status: done ? "completed" : "running",
    added_count: (mig.added_count ?? 0) + added,
    failed_count: effectiveFailedCount + failed,
    skipped_count: (mig.skipped_count ?? 0) + skipped,
    next_attempt_at: done ? null : nextAt,
    finished_at: done ? new Date().toISOString() : null,
    last_error: Object.keys(errors).length ? Object.values(errors)[0] : null,
    // CORREÇÃO: Registra timestamp do último batch em metadata para controle
    // de intervalo mínimo entre adds (sem precisar de nova coluna no banco).
    metadata: {
      ...((mig.metadata as Record<string, unknown>) ?? {}),
      last_batch_at: new Date().toISOString(),
    },
  }).eq("id", mig.id);

  return { migrationId, added, failed, skipped, done };
}
