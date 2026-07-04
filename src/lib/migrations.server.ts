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
  // CORREÇÃO CRÍTICA (endurecida): floors elevados para 60s / 180s.
  // Testes de campo mostram que qualquer valor < 60s por add em grupo dispara
  // device_removed no Baileys. 60-180s é a janela recomendada por operadores
  // de larga escala. Se o usuário configurou algo menor na UI, sobrescrevemos
  // silenciosamente pelo floor — priorizamos manter a sessão viva.
  const minFloor = Math.max(60, Number(process.env.MIGRATION_MIN_DELAY_FLOOR_SECONDS ?? 60));
  const maxFloor = Math.max(180, Number(process.env.MIGRATION_MAX_DELAY_FLOOR_SECONDS ?? 180));
  const min = Math.max(
    Number.isFinite(Number(minValue)) ? Number(minValue) : 60,
    Number.isFinite(minFloor) ? minFloor : 60,
  );
  const max = Math.max(
    Number.isFinite(Number(maxValue)) ? Number(maxValue) : 180,
    Number.isFinite(maxFloor) ? maxFloor : 180,
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

function phoneKey(value: unknown): string {
  const phone = digits(value);
  // Brasil: às vezes a Evolution/WhatsApp alterna 55 + DDD + 8/9 dígitos.
  // Usar os últimos 8 dígitos como alias evita falso "failed" quando o retorno
  // vem com/sem DDI ou com nono dígito divergente.
  return phone.length > 8 ? phone.slice(-8) : phone;
}

function isLoggedOutEvolutionError(error: unknown): boolean {
  const haystack = typeof error === "object" && error !== null
    ? JSON.stringify(error, Object.getOwnPropertyNames(error)).toLowerCase()
    : String(error ?? "").toLowerCase();
  return (
    haystack.includes("device_removed") ||
    haystack.includes("logout") ||
    haystack.includes("logged out") ||
    haystack.includes("logged_out") ||
    haystack.includes("unpaired")
  );
}

function hasExplicitPairingLossText(source: unknown): boolean {
  const haystack = typeof source === "object" && source !== null
    ? JSON.stringify(source, Object.getOwnPropertyNames(source)).toLowerCase()
    : String(source ?? "").toLowerCase();
  return (
    haystack.includes("device_removed") ||
    haystack.includes("logged_out") ||
    haystack.includes("logged out") ||
    haystack.includes("logout") ||
    haystack.includes("unpaired") ||
    haystack.includes("pairing_lost") ||
    haystack.includes("reauth_required")
  );
}

function isAuthLikeTransientDuringMigration(source: unknown): boolean {
  if (hasExplicitPairingLossText(source)) return false;
  const haystack = typeof source === "object" && source !== null
    ? JSON.stringify(source, Object.getOwnPropertyNames(source)).toLowerCase()
    : String(source ?? "").toLowerCase();
  return (
    haystack.includes("401") ||
    haystack.includes("unauthoriz") ||
    haystack.includes("forbidden") ||
    haystack.includes("not connected") ||
    haystack.includes("not_connected")
  );
}

async function auditLog(supabase: any, args: {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabase.from("audit_logs").insert({
      user_id: args.userId ?? null,
      action: args.action,
      entity: args.entity ?? "group_migration",
      entity_id: args.entityId ?? null,
      metadata: args.metadata ?? {},
    });
  } catch { /* audit best-effort */ }
}

function pairingLostSignal(_conn: any, state?: any): boolean {
  // IMPORTANTE: NÃO varrer conn.metadata aqui. markConnectionReauthRequired
  // grava breadcrumbs (`pairing_lost_reason: "device_removed"`, `status_reason: 401`,
  // `device_removed_at`) que ficam no metadata mesmo após reconexão bem-sucedida.
  // Se olharmos o metadata, o próximo tick lê o rastro antigo e re-pausa tudo
  // logo após o primeiro batch. Confia SÓ no estado vivo retornado por
  // evolution.state() nesta chamada.
  if (!state) return false;
  const reason =
    state?.instance?.statusReason ??
    state?.statusReason ??
    state?.data?.statusReason ??
    state?.data?.instance?.statusReason;
  const reasonText = String(reason ?? "").toLowerCase();
  if (
    reasonText.includes("device_removed") ||
    reasonText.includes("logged_out") ||
    reasonText.includes("logged out") ||
    reasonText.includes("logout") ||
    reasonText.includes("unpaired")
  ) return true;
  const stateField = String(
    state?.instance?.state ??
    state?.instance?.status ??
    state?.data?.state ??
    state?.data?.status ??
    state?.state ??
    state?.status ??
    "",
  ).toLowerCase();
  return (
    stateField.includes("device_removed") ||
    stateField.includes("logged_out") ||
    stateField.includes("logged out") ||
    stateField === "logout" ||
    stateField.includes("unpaired")
  );
}

async function requeueTransientFailures(supabase: any, migrationId: string) {
  const { data: failedRows } = await supabase.from("group_migration_targets")
    .select("id,error")
    .eq("migration_id", migrationId)
    .eq("status", "failed")
    .or("error.ilike.%Connection Closed%,error.ilike.%Connection Close%,error.ilike.%timeout%,error.ilike.%socket%,error.ilike.%stream:error%,error.ilike.%not connected%,error.eq.");

  if (!failedRows?.length) return 0;

  await supabase.from("group_migration_targets").update({
    status: "pending",
    error: null,
  }).in("id", failedRows.map((row: any) => row.id));

  return failedRows.length;
}

async function updateMigrationSafe(supabase: any, migrationId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("group_migrations").update(patch).eq("id", migrationId);
  if (!error) return;

  // Compatibilidade self-hosted: versões antigas do banco não tinham
  // group_migrations.metadata. Não deixa o batch quebrar depois de já ter
  // adicionado participante; salva o essencial e registra auditoria via logs.
  const msg = String(error.message ?? error).toLowerCase();
  if ("metadata" in patch && (msg.includes("metadata") || msg.includes("schema cache") || msg.includes("column"))) {
    const { metadata: _metadata, ...withoutMetadata } = patch;
    const retry = await supabase.from("group_migrations").update(withoutMetadata).eq("id", migrationId);
    if (!retry.error) return;
    throw new Error(retry.error.message ?? String(retry.error));
  }

  throw new Error(error.message ?? String(error));
}

// CORREÇÃO CRÍTICA (itens 1 e 2):
// Lock distribuído por CONEXÃO — via UPDATE atômico condicional na coluna
// connections.processing_until (migration 008_migration_locks.sql). Isso
// funciona corretamente em qualquer topologia (Lovable serverless com
// múltiplas réplicas, VPS com PM2 cluster, ou processo único), enquanto o
// Map em globalThis só protegia dentro do mesmo processo Node.
// Escopado por connection_id (não por migration_id) porque duas migrações
// da mesma conexão WhatsApp precisam ir em fila serial — caso contrário
// ambas chamariam addGroupParticipants na mesma instância simultaneamente,
// dobrando a taxa real e anulando o delay anti-restrição.
const LOCK_TTL_MS = 55_000; // 55s > budget do tick (25s), evita lock eterno em crash

async function acquireConnectionLock(supabase: any, connectionId: string): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  const { data } = await supabase.from("connections")
    .update({ processing_until: until })
    .eq("id", connectionId)
    .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
    .select("id")
    .maybeSingle();
  return data ? until : null;
}

async function releaseConnectionLock(supabase: any, connectionId: string, lockUntil: string): Promise<void> {
  try {
    await supabase.from("connections")
      .update({ processing_until: null })
      .eq("id", connectionId)
      .eq("processing_until", lockUntil);
  } catch { /* best-effort */ }
}

/**
 * Trata queda de sessão durante a migração de forma GRADUAL:
 * antes de pausar tudo e exigir novo QR, tenta restart silencioso até
 * `MIGRATION_MAX_SESSION_DROPS` (default 6) vezes consecutivas, com backoff
 * exponencial. Só marca `reauth_required` após esgotar as tentativas.
 *
 * Motivo: Baileys costuma reportar `close`/`statusReason:401` transitório
 * logo após `addGroupParticipants` e volta sozinho em segundos. O
 * comportamento antigo (pausar já na primeira detecção) obrigava o usuário
 * a rescanear QR toda vez que a sessão oscilava — mesmo sem logout real.
 *
 * Contador vive em `connections.metadata.session_drop_count` e é resetado
 * a cada batch bem-sucedido.
 */
async function handleSessionDrop(
  supabase: any,
  mig: any,
  conn: any,
  instance: string,
  reason: unknown,
): Promise<{ decision: "reauth_required" | "graceful_retry"; failCount: number }> {
  const meta = (conn?.metadata as Record<string, any> | null) ?? {};
  const prev = Number(meta.session_drop_count ?? 0);
  const failCount = prev + 1;
  const maxFails = Math.max(6, Number(process.env.MIGRATION_MAX_SESSION_DROPS ?? 6));
  const reasonStr = typeof reason === "string" ? reason : (reason as any)?.message ?? JSON.stringify(reason);

  await auditLog(supabase, {
    userId: mig.user_id,
    action: "migration_session_drop",
    entity: "connection",
    entityId: mig.connection_id,
    metadata: {
      instance,
      reason: String(reasonStr ?? ""),
      fail_count: failCount,
      max_fails: maxFails,
      migration_id: mig.id,
    },
  });

  if (failCount >= maxFails) {
    // Antes de pausar/matar a automação, confirma com o estado vivo da
    // Evolution. Se o limite foi atingido por 401/close transitório, mantém a
    // fila em backoff em vez de exigir QR e derrubar o WhatsApp.
    const confirmation = await resolveEvolutionStatus(instance).catch(() => null);
    if (hasExplicitPairingLossText(confirmation?.state ?? reason)) {
      await markConnectionReauthRequired(supabase, {
        connectionId: mig.connection_id,
        userId: mig.user_id,
        instanceName: instance,
        reason: String(reasonStr ?? "device_removed"),
      });
      await requeueTransientFailures(supabase, mig.id);
      await auditLog(supabase, {
        userId: mig.user_id,
        action: "migration_reauth_confirmed",
        entity: "connection",
        entityId: mig.connection_id,
        metadata: { instance, migration_id: mig.id, confirmation_state: confirmation?.state ?? null, fail_count: failCount },
      });
      return { decision: "reauth_required", failCount };
    }

    await auditLog(supabase, {
      userId: mig.user_id,
      action: "migration_reauth_suppressed",
      entity: "connection",
      entityId: mig.connection_id,
      metadata: { instance, migration_id: mig.id, confirmation_state: confirmation?.state ?? null, fail_count: failCount },
    });
  }

  // Restart silencioso com circuito: não reinicia na primeira oscilação e não
  // reinicia em rajada. O restart em loop logo após addGroupParticipants era a
  // principal fonte de sobrecarga e queda total da sessão.
  const autoRestartEnabled = String(process.env.MIGRATION_AUTO_RESTART_ON_DROP ?? "").toLowerCase() === "true";
  const restartAfterDrops = Number(process.env.MIGRATION_RESTART_AFTER_DROPS ?? 2);
  const restartCooldownMs = Number(process.env.MIGRATION_RESTART_COOLDOWN_MS ?? 120_000);
  const lastRestartAt = Date.parse(String(meta.migration_restart_at ?? "")) || 0;
  const shouldRestart = autoRestartEnabled && failCount >= restartAfterDrops && Date.now() - lastRestartAt > restartCooldownMs;
  if (shouldRestart) {
    await evolution.restart(instance).catch(() => undefined);
    await auditLog(supabase, {
      userId: mig.user_id,
      action: "migration_silent_restart",
      entity: "connection",
      entityId: mig.connection_id,
      metadata: { instance, migration_id: mig.id, fail_count: failCount, restart_after_drops: restartAfterDrops },
    });
  }

  await supabase.from("connections").update({
    status: conn?.status === "online" ? "online" : "connecting",
    auto_reconnect: true,
    disconnected_manually: false,
    last_sync_at: new Date().toISOString(),
    metadata: {
      ...meta,
      evolution_instance: instance,
      session_drop_count: failCount,
      last_session_drop_at: new Date().toISOString(),
      last_session_drop_reason: String(reasonStr ?? ""),
      evolution_state: shouldRestart ? "graceful_restart_pending" : "migration_backoff_without_restart",
      migration_recovery_status_preserved: conn?.status === "online",
      ...(shouldRestart ? { migration_restart_at: new Date().toISOString() } : {}),
    },
  }).eq("id", mig.connection_id).eq("user_id", mig.user_id);

  // Backoff exponencial mais generoso: 3min → 6min → 12min (teto 15min).
  // Backoffs curtos após queda de sessão faziam o próximo add cair no mesmo
  // estado instável e derrubar a sessão de vez.
  const baseMs = Number(process.env.MIGRATION_SESSION_DROP_BACKOFF_MS ?? 180_000);
  const capMs = Number(process.env.MIGRATION_SESSION_DROP_BACKOFF_CAP_MS ?? 900_000);
  const backoffMs = Math.min(baseMs * (2 ** (failCount - 1)), capMs);

  await requeueTransientFailures(supabase, mig.id);
  // Após 2 quedas consecutivas, auto-PAUSA a migração para o usuário revisar
  // manualmente antes de continuar — melhor pausar do que insistir e queimar
  // a sessão. O usuário reativa via botão "Retomar" no painel.
  const autoPauseAt = Number(process.env.MIGRATION_AUTO_PAUSE_AFTER_DROPS ?? 2);
  const shouldAutoPause = failCount >= autoPauseAt;
  await supabase.from("group_migrations").update({
    status: shouldAutoPause ? "paused" : mig.status,
    next_attempt_at: shouldAutoPause ? null : new Date(Date.now() + backoffMs).toISOString(),
    last_error: shouldAutoPause
      ? `Sessão oscilou ${failCount}x seguidas — migração PAUSADA automaticamente para proteger a conexão. Confirme se o WhatsApp está estável e clique em Retomar.`
      : `Sessão oscilou (queda ${failCount}/${maxFails}). Aguardando ${Math.round(backoffMs / 1000)}s antes da próxima tentativa.`,
  }).eq("id", mig.id);

  return { decision: "graceful_retry", failCount };
}



export async function processGroupMigrationBatch(supabase: any, migrationId: string, userIdScope?: string) {
  // Precisamos do connection_id antes de pegar a trava — carrega a migração primeiro.
  let q = supabase.from("group_migrations").select("*").eq("id", migrationId);
  if (userIdScope) q = q.eq("user_id", userIdScope);
  const { data: mig } = await q.maybeSingle();
  if (!mig) throw new Error("Migração não encontrada");
  if (mig.status !== "running" && mig.status !== "pending") {
    return { migrationId, skipped: true, reason: `status=${mig.status}` };
  }
  if (!mig.target_group_jid) throw new Error("Grupo destino ausente");

  const lockUntil = await acquireConnectionLock(supabase, mig.connection_id);
  if (!lockUntil) {
    return { migrationId, skipped: true, reason: "locked_by_concurrent_process" };
  }

  try {
    return await _processGroupMigrationBatchInner(supabase, mig);
  } finally {
    await releaseConnectionLock(supabase, mig.connection_id, lockUntil);
  }
}

async function _processGroupMigrationBatchInner(supabase: any, mig: any) {
  const migrationId = mig.id;


  // Escopa o lookup de conexão pelo user_id da migração, mesmo usando o
  // admin client — evita que uma migração forjada aponte para a conexão de
  // outro usuário.
  const { data: conn } = await supabase
    .from("connections")
    .select("status,metadata,user_id,last_reconnect_attempt_at")
    .eq("id", mig.connection_id)
    .eq("user_id", mig.user_id)
    .maybeSingle();
  if (!conn) throw new Error("Conexão não encontrada");
  const instance = conn.metadata?.evolution_instance ?? instanceNameFor(mig.connection_id);

  const tryReconnect = async () => {
    // CORREÇÃO (item 2): cooldown por CONEXÃO persistido no banco em
    // connections.last_reconnect_attempt_at — antes era um Map em globalThis
    // que não protegia entre processos/réplicas. Cooldown curto por padrão:
    // 10min deixava a conexão presa em "Conectando" após uma tentativa falha.
    const cooldownMs = Math.max(120_000, Number(process.env.MIGRATION_RECONNECT_COOLDOWN_MS ?? 300_000));
    const cutoffIso = new Date(Date.now() - cooldownMs).toISOString();
    const { data: reconnectClaim } = await supabase.from("connections")
      .update({ last_reconnect_attempt_at: new Date().toISOString() })
      .eq("id", mig.connection_id).eq("user_id", mig.user_id)
      .or(`last_reconnect_attempt_at.is.null,last_reconnect_attempt_at.lt.${cutoffIso}`)
      .select("id,status,metadata")
      .maybeSingle();
    if (!reconnectClaim) return false;
    // Por padrão NÃO reinicia automaticamente durante migração. Restart em
    // loop logo após addGroupParticipants é uma das maiores fontes de carga e
    // queda da sessão. Quando habilitado por env, usa restart preservando sessão.
    const allowAutoRestart = String(process.env.MIGRATION_ALLOW_AUTO_RESTART ?? "").toLowerCase() === "true";
    const recovered = allowAutoRestart
      ? await reconnectEvolutionSession(instance, { attempts: 2, delayMs: 2_000 }).catch(() => null)
      : await resolveEvolutionStatus(instance).catch(() => null);
    if (recovered) {
      await supabase.from("connections").update({
        status: recovered.status,
        ...(recovered.status === "online" ? { qr_code: null } : {}),
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...(reconnectClaim.metadata ?? conn.metadata ?? {}),
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
        // Reconciliação: limpa breadcrumbs antigos de drops para que o próximo
        // tick não interprete metadata legado como "pareamento perdido".
        const cleanMeta = { ...(conn.metadata ?? {}) } as Record<string, unknown>;
        delete cleanMeta.pairing_lost_at;
        delete cleanMeta.pairing_lost_reason;
        delete cleanMeta.device_removed_at;
        delete cleanMeta.status_reason;
        delete cleanMeta.last_evolution_error_code;
        delete cleanMeta.session_drop_count;
        delete cleanMeta.last_session_drop_at;
        delete cleanMeta.last_session_drop_reason;
        cleanMeta.evolution_instance = instance;
        cleanMeta.evolution_state = "open";
        await supabase.from("connections").update({
          status: "online",
          qr_code: null,
          last_seen_online_at: new Date().toISOString(),
          metadata: cleanMeta,
        }).eq("id", mig.connection_id).eq("user_id", mig.user_id);
      } else {
        const state = resolved.state ?? resolved.status;
        const sessionRemoved = isLoggedOutEvolutionError(state) || pairingLostSignal(conn, state);
          if (sessionRemoved) {
            const { data: freshConn } = await supabase.from("connections")
              .select("status,metadata,user_id,last_reconnect_attempt_at")
              .eq("id", mig.connection_id)
              .eq("user_id", mig.user_id)
              .maybeSingle();
            const outcome = await handleSessionDrop(supabase, mig, freshConn ?? conn, instance, state ?? "device_removed");
            return { migrationId, skipped: true, reason: outcome.decision, sessionDropCount: outcome.failCount };
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

  // CORREÇÃO: estabilização sem bloquear o Worker.
  // Antes o código fazia setTimeout aqui segurando a trava/conexão aberta.
  // Em Lovable/serverless ou VPS com cron isso acumulava ticks e aumentava a
  // pressão na Evolution logo após o primeiro batch. Agora apenas reagenda o
  // próximo attempt e libera a instância.
  const lastAddedAt = (mig.metadata as any)?.last_batch_at
    ? new Date((mig.metadata as any).last_batch_at).getTime()
    : 0;
  const minIntervalMs = Math.max(60_000, Number(process.env.MIGRATION_MIN_INTERVAL_MS ?? 60_000));
  const elapsed = Date.now() - lastAddedAt;
  if (elapsed < minIntervalMs) {
    const waitMs = Math.max(1_000, minIntervalMs - elapsed);
    const nextAttemptAt = new Date(Date.now() + waitMs).toISOString();
    await supabase.from("group_migrations").update({
      next_attempt_at: nextAttemptAt,
      last_error: null,
    }).eq("id", mig.id);
    try {
      await supabase.from("audit_logs").insert({
        user_id: mig.user_id,
        action: "migration_rate_limited",
        entity: "group_migration",
        entity_id: mig.id,
        metadata: {
          connection_id: mig.connection_id,
          wait_ms: waitMs,
          min_interval_ms: minIntervalMs,
          last_batch_at: (mig.metadata as any)?.last_batch_at ?? null,
        },
      });
    } catch { /* audit best-effort */ }
    return { migrationId, skipped: true, reason: "rate_limited", nextAttemptAt };
  }

  const requeued = await requeueTransientFailures(supabase, mig.id);
  const effectiveFailedCount = Math.max(0, (mig.failed_count ?? 0) - requeued);

  const effectiveBatchSize = automationBatchSize(mig.batch_size);
  // Idempotência: seleciona SOMENTE status="pending" e explicitamente exclui
  // "added"/"skipped"/"failed" — evita reprocessar quem já entrou no grupo
  // (belt-and-suspenders: já filtrado por status, o .not garante que uma
  // corrida de status não faça double-add).
  const { data: batch } = await supabase.from("group_migration_targets")
    .select("*").eq("migration_id", mig.id).eq("status", "pending")
    .not("status", "in", "(added,skipped)")
    .limit(effectiveBatchSize);

  if (!batch || batch.length === 0) {
    await supabase.from("group_migrations").update({
      status: "completed", finished_at: new Date().toISOString(),
    }).eq("id", mig.id);
    return { migrationId, completed: true };
  }

  // Pré-check: descarta números sem WhatsApp ativo antes do add. DESLIGADO
  // por padrão — cada chamada à Evolution imediatamente antes do
  // addGroupParticipants aumenta o risco de stream:error/device_removed no
  // Baileys. Ative com MIGRATION_PRECHECK_NUMBERS=true apenas se sua base
  // tiver muitos números inválidos e você aceitar o custo. Sem pré-check, os
  // inválidos caem naturalmente como "failed" no retorno do próprio add.
  if (String(process.env.MIGRATION_PRECHECK_NUMBERS ?? "").toLowerCase() === "true") try {
    const nums = batch.map((t: any) => t.phone).filter(Boolean);
    const check = await evolution.checkWhatsappNumbers(instance, nums);

    if (check.length) {
      const invalid = new Set(
        check.filter((r) => !r.exists).map((r) => r.number),
      );
      if (invalid.size) {
        const invalidRows = batch.filter((t: any) => invalid.has(String(t.phone).replace(/\D/g, "")));
        for (const t of invalidRows) {
          await supabase.from("group_migration_targets").update({
            status: "skipped", error: "número não tem WhatsApp",
          }).eq("id", t.id);
        }
        for (const t of invalidRows) {
          const idx = batch.indexOf(t);
          if (idx >= 0) batch.splice(idx, 1);
        }
      }
    }
    if (batch.length === 0) {
      return { migrationId, added: 0, failed: 0, skipped: 0, done: false };
    }
  } catch { /* pré-check é best-effort */ }

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
      if (phone) {
        byPhone[phone] = item;
        byPhone[phoneKey(phone)] = item;
      }
    }

    // Não fazer nenhuma leitura de participantes após o add. A decisão de
    // sucesso/falha vem 100% do retorno do próprio addGroupParticipants().
    for (const t of batch) {
      const expectedPhone = sendPhoneFor(t.phone);
      const resolvedIt = byPhone[expectedPhone] ?? byPhone[t.phone] ?? byPhone[phoneKey(expectedPhone)] ?? byPhone[phoneKey(t.phone)];
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
          // Resposta vazia: assumir sucesso (comportamento observado na Evolution v2),
          // mas deixando rastro visível para revisão/auditoria em produção.
          await supabase.from("group_migration_targets").update({
            status: "added", phone: expectedPhone, jid: `${expectedPhone}@s.whatsapp.net`,
            added_at: new Date().toISOString(),
            error: "resposta_vazia_presumido_sucesso",
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
    if (hasExplicitPairingLossText(e) && (isPairingLostEvolutionError(e) || isLoggedOutEvolutionError(e))) {
      // Não pausa de cara: usa handleSessionDrop (restart + backoff).
      // Só marca reauth_required após MIGRATION_MAX_SESSION_DROPS quedas
      // consecutivas — evita QR desnecessário quando a sessão volta sozinha.
      const { data: freshConn } = await supabase.from("connections")
        .select("status,metadata,user_id,last_reconnect_attempt_at")
        .eq("id", mig.connection_id)
        .eq("user_id", mig.user_id)
        .maybeSingle();
      const outcome = await handleSessionDrop(supabase, mig, freshConn ?? conn, instance, e);
      if (outcome.decision === "reauth_required") {
        return { migrationId, added: 0, failed: 0, skipped: 0, done: false, reauthRequired: true, message: REAUTH_REQUIRED_MESSAGE, sessionDropCount: outcome.failCount };
      }
      return { migrationId, added: 0, failed: 0, skipped: 0, done: false, retriedLater: true, sessionDropCount: outcome.failCount };
    }

    if (isTransientEvolutionError(e) || isAuthLikeTransientDuringMigration(e)) {
      // CORREÇÃO (item 6): backoff EXPONENCIAL para falhas transientes.
      // Antes: delay fixo (30s) independente de quantas falhas seguidas.
      // Agora: 30s → 60s → 120s → 240s (teto 5min), com contador em
      // metadata.consecutive_transient_failures. É resetado para 0 no
      // update final quando o batch tem sucesso (bloco abaixo).
      const baseMs = Number(process.env.MIGRATION_TRANSIENT_RETRY_MS ?? 30_000);
      const capMs = Number(process.env.MIGRATION_TRANSIENT_RETRY_CAP_MS ?? 300_000);
      const consecutive = Number((mig.metadata as any)?.consecutive_transient_failures ?? 0);
      const retryDelayMs = Math.min(baseMs * (2 ** consecutive), capMs);
      const nextConsecutive = consecutive + 1;
      await updateMigrationSafe(supabase, mig.id, {
        failed_count: effectiveFailedCount,
        next_attempt_at: new Date(Date.now() + retryDelayMs).toISOString(),
        last_error: `Conexão instável durante adição — retry automático em ${Math.round(retryDelayMs / 1000)}s (falha ${nextConsecutive}, backoff exponencial)`,
        metadata: {
          ...((mig.metadata as Record<string, unknown>) ?? {}),
          last_batch_at: new Date().toISOString(),
          consecutive_transient_failures: nextConsecutive,
          last_transient_failure_at: new Date().toISOString(),
        },
      });
      // Log de auditoria para acompanhar o padrão de falhas transientes.
      await auditLog(supabase, {
        userId: mig.user_id,
        action: "migration_transient_backoff",
        entity: "group_migration",
        entityId: mig.id,
        metadata: {
          consecutive_failures: nextConsecutive,
          retry_delay_ms: retryDelayMs,
          error: String(e?.message ?? e),
          auth_like_transient: isAuthLikeTransientDuringMigration(e),
        },
      });
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

  // Se o batch conseguiu adicionar/skippar alguém, resetamos o contador de
  // falhas transientes consecutivas (item 6).
  const hadProgress = added > 0 || skipped > 0;
  const prevMeta = (mig.metadata as Record<string, unknown>) ?? {};
  const nextMeta: Record<string, unknown> = {
    ...prevMeta,
    last_batch_at: new Date().toISOString(),
  };
  if (hadProgress) nextMeta.consecutive_transient_failures = 0;

  await updateMigrationSafe(supabase, mig.id, {
    status: done ? "completed" : "running",
    added_count: (mig.added_count ?? 0) + added,
    failed_count: effectiveFailedCount + failed,
    skipped_count: (mig.skipped_count ?? 0) + skipped,
    next_attempt_at: done ? null : nextAt,
    finished_at: done ? new Date().toISOString() : null,
    last_error: Object.keys(errors).length ? Object.values(errors)[0] : null,
    metadata: nextMeta,
  });

  // Reset do contador de quedas de sessão quando o batch de fato progrediu.
  // Isso garante que uma oscilação isolada não conte para sempre — só quedas
  // CONSECUTIVAS somam para o limite MIGRATION_MAX_SESSION_DROPS.
  if (hadProgress) {
    try {
      const { data: freshConn } = await supabase.from("connections")
        .select("metadata")
        .eq("id", mig.connection_id)
        .eq("user_id", mig.user_id)
        .maybeSingle();
      const connMeta = ((freshConn ?? conn)?.metadata as Record<string, unknown> | null) ?? {};
      if (Number((connMeta as any).session_drop_count ?? 0) > 0) {
        const cleaned = { ...connMeta };
        delete (cleaned as any).session_drop_count;
        delete (cleaned as any).last_session_drop_at;
        delete (cleaned as any).last_session_drop_reason;
        delete (cleaned as any).pairing_lost_at;
        delete (cleaned as any).pairing_lost_reason;
        delete (cleaned as any).device_removed_at;
        delete (cleaned as any).status_reason;
        await supabase.from("connections")
          .update({ metadata: cleaned })
          .eq("id", mig.connection_id).eq("user_id", mig.user_id);
      }
    } catch { /* best-effort */ }
  }


  return { migrationId, added, failed, skipped, done };
}
