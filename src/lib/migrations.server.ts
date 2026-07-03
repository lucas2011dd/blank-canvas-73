// Server-only worker para processar 1 batch de uma migração de grupo.
// É importado dinamicamente por server functions e pelo cron público
// (/api/public/wa/tick). NUNCA importe no cliente.
import { evolution, isTransientEvolutionError, reconnectEvolutionSession, resolveEvolutionStatus } from "@/lib/evolution.server";

function instanceNameFor(id: string) {
  return `ch_${id.replace(/-/g, "")}`;
}

function jitter(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function automationBatchSize(value: unknown): number {
  const configured = Number(value ?? 1);
  const envMax = Number(process.env.MIGRATION_MAX_BATCH_SIZE ?? 1);
  const max = Number.isFinite(envMax) && envMax > 0 ? Math.floor(envMax) : 1;
  return Math.max(1, Math.min(Number.isFinite(configured) ? Math.floor(configured) : 1, max));
}

function automationDelaySeconds(minValue: unknown, maxValue: unknown): number {
  const minFloor = Number(process.env.MIGRATION_MIN_DELAY_FLOOR_SECONDS ?? 10);
  const maxFloor = Number(process.env.MIGRATION_MAX_DELAY_FLOOR_SECONDS ?? 20);
  const min = Math.max(
    Number.isFinite(Number(minValue)) ? Number(minValue) : 15,
    Number.isFinite(minFloor) ? minFloor : 10,
  );
  const max = Math.max(
    Number.isFinite(Number(maxValue)) ? Number(maxValue) : 30,
    Number.isFinite(maxFloor) ? maxFloor : 20,
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

function needsManualQr(conn: any, state?: any): boolean {
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

export async function processGroupMigrationBatch(supabase: any, migrationId: string, userIdScope?: string) {
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
    // Cooldown de 5 min por instância: reconectar toda hora é interpretado
    // pelo WhatsApp como comportamento suspeito e força device_removed.
    const cooldownMs = Number(process.env.MIGRATION_RECONNECT_COOLDOWN_MS ?? 5 * 60_000);
    const cache: Map<string, number> = ((globalThis as any).__migrationReconnectAt ??= new Map());
    const last = cache.get(instance) ?? 0;
    if (Date.now() - last < cooldownMs) return false;
    cache.set(instance, Date.now());
    // Reconecta preservando a sessão: restart/reload da instância, nunca /connect.
    const recovered = await reconnectEvolutionSession(instance, { attempts: 2, delayMs: 1_500 }).catch(() => null);
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
        const sessionRemoved = isLoggedOutEvolutionError(state) || needsManualQr(conn, state);
        const recovered = sessionRemoved ? false : await tryReconnect();
        if (recovered) {
          await supabase.from("connections").update({ status: "online", qr_code: null }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
        } else {
        const requeued = await requeueTransientFailures(supabase, mig.id);
        await supabase.from("connections").update({ status: resolved.status }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
        await supabase.from("group_migrations").update({
          failed_count: Math.max(0, (mig.failed_count ?? 0) - requeued),
          next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
          last_error: sessionRemoved
            ? "WhatsApp saiu dos aparelhos conectados — pausa mantida sem gerar novo QR automático"
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
        next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
        last_error: "Evolution indisponível — tentando reconectar sem novo QR em 30s",
      }).eq("id", mig.id);
      return { migrationId, skipped: true, reason: "connection_offline" };
      }
    }
  }

  try {
    const resolved = await resolveEvolutionStatus(instance);
    if (resolved.status !== "online") {
      const state = await evolution.state(instance).catch(() => null);
      const sessionRemoved = needsManualQr(conn, state);
      const recovered = sessionRemoved ? false : await tryReconnect();
      if (!recovered) {
      const requeued = await requeueTransientFailures(supabase, mig.id);
      await supabase.from("connections").update({ status: resolved.status }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
      await supabase.from("group_migrations").update({
        failed_count: Math.max(0, (mig.failed_count ?? 0) - requeued),
        next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
        last_error: sessionRemoved
          ? "WhatsApp desconectado/removido — pausa mantida sem gerar novo QR automático"
          : "Conexão oscilou — reconexão sem novo QR em andamento; fila retoma em 30s",
      }).eq("id", mig.id);
      return { migrationId, skipped: true, reason: "evolution_connection_closed" };
      }
    }
  } catch (e) {
    if (isLoggedOutEvolutionError(e)) {
      await supabase.from("connections").update({ status: "offline", qr_code: null }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
      await supabase.from("group_migrations").update({
        next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
        last_error: "WhatsApp removido dos aparelhos conectados — pausa mantida sem gerar novo QR automático",
      }).eq("id", mig.id);
      return { migrationId, skipped: true, reason: "device_removed" };
    }
    if (isTransientEvolutionError(e)) {
      const recovered = await tryReconnect();
      if (recovered) {
        await supabase.from("connections").update({ status: "online", qr_code: null }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
      } else {
      await supabase.from("group_migrations").update({
        next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
        last_error: "Evolution temporariamente indisponível — reconexão sem novo QR em 30s",
      }).eq("id", mig.id);
      return { migrationId, skipped: true, reason: "evolution_temporarily_unavailable" };
      }
    }
    throw e;
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
  const phoneByOriginal = new Map<string, string>();

  try {
    const sourceParticipants = await evolution.groupParticipants(instance, mig.source_group_jid);
    for (const p of sourceParticipants) {
      const participant: any = p;
      const realPhone = participantPhone(p);
      if (!realPhone) continue;
      for (const candidate of [participant?.id, participant?.jid, participant?.phoneNumber, participant?.phone_number, participant?.number]) {
        const key = digits(candidate);
        if (key) phoneByOriginal.set(key, realPhone);
      }
    }
  } catch { /* se falhar, processa com o que já está salvo */ }

  const sendPhoneFor = (phone: string) => phoneByOriginal.get(phone) ?? phone;
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

    // Só consulta a lista completa do grupo quando a Evolution não retornou
    // status por telefone. Fazer `findGroupInfos` após todo add força cache de
    // grupo e aumenta a chance de travar/derrubar a sessão durante migrações.
    let joinedSet = new Set<string>();
    const needsMembershipVerification = list.length === 0 || batch.some((t: any) => {
      const expectedPhone = sendPhoneFor(t.phone);
      return !byPhone[t.phone] && !byPhone[expectedPhone];
    });
    if (needsMembershipVerification) {
      try {
        const parts = await evolution.groupParticipants(instance, mig.target_group_jid);
        joinedSet = new Set(parts.map((p: any) => {
          return participantPhone(p);
        }).filter(Boolean));
      } catch { /* fallback: usa apenas o retorno da chamada */ }
    }

    for (const t of batch) {
      const expectedPhone = sendPhoneFor(t.phone);
      const it = byPhone[t.phone];
      const resolvedIt = byPhone[expectedPhone] ?? it;
      const rawStatus = String(resolvedIt?.status ?? "");
      const apiSuccess = rawStatus === "success" || rawStatus === "200" || (resolvedIt && !resolvedIt?.message);
      const joined = joinedSet.size ? joinedSet.has(expectedPhone) : apiSuccess;

      if (joined) {
        await supabase.from("group_migration_targets").update({
          status: "added", phone: expectedPhone, jid: `${expectedPhone}@s.whatsapp.net`, added_at: new Date().toISOString(),
        }).eq("id", t.id);
        added++;
      } else if (rawStatus === "skipped" || rawStatus === "already_in_group") {
        await supabase.from("group_migration_targets").update({ status: "skipped", error: rawStatus }).eq("id", t.id);
        skipped++;
      } else {
        const err = String(resolvedIt?.message || rawStatus || "não entrou no grupo (privacidade/bloqueio/não é WhatsApp)");
        await supabase.from("group_migration_targets").update({ phone: expectedPhone, jid: `${expectedPhone}@s.whatsapp.net`, status: "failed", error: err }).eq("id", t.id);
        failed++;
        errors[t.phone] = err;
      }
    }
  } catch (e: any) {
    if (isTransientEvolutionError(e)) {
      const recovered = await tryReconnect();
      await supabase.from("group_migrations").update({
        failed_count: effectiveFailedCount,
        next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
        last_error: recovered
          ? "Conexão recuperada sem novo QR — retry em 30s, lote mantido pendente"
          : "Conexão caiu durante a adição — reconectando sem novo QR, lote mantido pendente",
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
  }).eq("id", mig.id);

  return { migrationId, added, failed, skipped, done };
}
