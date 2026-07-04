// Endpoint público para "tick" de processamento — chame periodicamente via
// cron externo (p.ex. cron-job.org a cada 1min):
//   GET https://SEU-DOMINIO/api/public/wa/tick
//   Header: X-Tick-Secret: XXX
// Protegido por TICK_SECRET. O segredo é aceito APENAS via header
// para não vazar em logs de proxy/CDN/referrer.
import { createFileRoute } from "@tanstack/react-router";
import { buildWebhookUrl } from "@/lib/webhook-url";

// Rate limit simples em memória (por IP): 60 req/min.
const RATE: Map<string, { count: number; reset: number }> = (globalThis as any).__tickRate ??= new Map();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = RATE.get(ip);
  if (!bucket || bucket.reset < now) { RATE.set(ip, { count: 1, reset: now + 60_000 }); return false; }
  bucket.count++;
  return bucket.count > 60;
}

export const Route = createFileRoute("/api/public/wa/tick")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        if (rateLimited(ip)) return new Response("rate_limited", { status: 429 });

        const secret = process.env.TICK_SECRET ?? "";
        const got = request.headers.get("x-tick-secret") ?? "";
        if (!secret || got.length !== secret.length || got !== secret) {
          return new Response("unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { evolution } = await import("@/lib/evolution.server");

        const nowIso = new Date().toISOString();
        const summary = { broadcasts: 0, scheduled: 0, errors: 0, webhooks: 0, webhookErrors: 0, reauthPaused: 0 };

        // -------- Drena fila de webhooks (arquitetura assíncrona) --------
        // O endpoint /webhook/$instance só enfileira em webhook_logs. Aqui
        // processamos com retry/backoff, sem prender a Evolution em 30s.
        try {
          const { drainWebhookQueue } = await import("@/lib/webhook-processor.server");
          // CORREÇÃO: Limite de eventos por drain reduzido de 100 para 20.
          // Processar 100 webhooks de uma vez bloqueava o tick por até 15s,
          // deixando as migrações sem budget de tempo e causando timeouts
          // que o Baileys interpretava como queda da sessão.
          const drainDeadline = Date.now() + Number(process.env.TICK_WEBHOOK_DRAIN_BUDGET_MS ?? 2_000);
          const drainRes = await drainWebhookQueue(supabaseAdmin, 20, drainDeadline);
          summary.webhooks = drainRes.processed;
          summary.webhookErrors = drainRes.failed;
        } catch (e) {
          console.error("[tick] webhook drain failed", e);
        }

        // Repara webhooks e reconcilia o status real da Evolution (evita ficar
        // "connecting" quando o celular já apareceu como conectado).
        // Também varremos conexões offline com `auto_reconnect=true` e
        // `disconnected_manually=false` — só um "Desconectar" manual do
        // usuário interrompe a reconexão automática.
        const { data: webhookConns } = await supabaseAdmin.from("connections")
          .select("id,user_id,status,metadata,disconnected_manually,auto_reconnect")
          .eq("provider", "whatsapp")
          .or("status.eq.online,status.eq.connecting,and(status.eq.offline,disconnected_manually.eq.false,auto_reconnect.eq.true)")
          .limit(40);
        const { data: activeMigrationConns } = await supabaseAdmin.from("group_migrations")
          .select("connection_id")
          .eq("status", "running")
          .limit(100);
        const { data: activeBroadcastConns } = await supabaseAdmin.from("broadcasts")
          .select("connection_id")
          .eq("status", "running")
          .limit(100);
        const activeMigrationConnectionIds = new Set(
          (activeMigrationConns ?? []).map((row: any) => row.connection_id).filter(Boolean),
        );
        const activeAutomationConnectionIds = new Set([
          ...(activeMigrationConns ?? []).map((row: any) => row.connection_id).filter(Boolean),
          ...(activeBroadcastConns ?? []).map((row: any) => row.connection_id).filter(Boolean),
        ]);
        const { isPairingLostEvolutionError, isTransientEvolutionError, resolveEvolutionStatus } = await import("@/lib/evolution.server");
        const { markConnectionReauthRequired, REAUTH_REQUIRED_MESSAGE } = await import("@/lib/automation-safety.server");
        const { persistSessionSnapshot } = await import("@/lib/session-store.server");
        for (const conn of webhookConns ?? []) {
          // Durante migração ativa, não faça setWebhook/state/fetchInstances
          // nem restart no reconciliador. A própria migração gerencia restart
          // e backoff; reconciliar aqui criava loop: connecting → restart →
          // close → connecting após o primeiro batch.
          if (activeAutomationConnectionIds.has(conn.id)) continue;
          const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(conn.id).replace(/-/g, "")}`;
          const meta = (conn.metadata as Record<string, any> | null) ?? {};
          const now = Date.now();
          const lastReconcile = Date.parse(meta.tick_reconciled_at ?? meta.reconciled_at ?? "") || 0;
          const intervalMs = conn.status === "online"
            ? Number(process.env.TICK_ONLINE_RECONCILE_INTERVAL_MS ?? 600_000)
            : Number(process.env.TICK_RECOVER_RECONCILE_INTERVAL_MS ?? 180_000);
          if (lastReconcile && now - lastReconcile < intervalMs) continue;
          try {
            let resolved = await resolveEvolutionStatus(instance);
            // Auto-reconexão silenciosa (restart/reload — nunca /connect).
              if (resolved.status !== "online" && isPairingLostEvolutionError(resolved.state)) {
                await markConnectionReauthRequired(supabaseAdmin, {
                  connectionId: conn.id,
                  instanceName: instance,
                  reason: resolved.state ?? "device_removed",
                });
                summary.reauthPaused++;
                continue;
              }
            const evState = resolved.state;
            const realStatus = resolved.status;
            const storedStatus = realStatus === "offline" && conn.disconnected_manually !== true ? "connecting" : realStatus;
            if (storedStatus !== conn.status) {
              await supabaseAdmin.from("connections").update({
                status: storedStatus,
                ...(realStatus === "online" ? { qr_code: null, last_seen_online_at: new Date().toISOString() } : {}),
                last_sync_at: new Date().toISOString(),
                metadata: {
                  ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                  evolution_instance: instance,
                  evolution_state: realStatus === "offline" && conn.disconnected_manually !== true ? "silent_reconnect_pending" : evState,
                  last_evolution_state: evState,
                  reconciled_at: new Date().toISOString(),
                  tick_reconciled_at: new Date().toISOString(),
                },
              }).eq("id", conn.id);
            } else {
              await supabaseAdmin.from("connections").update({
                metadata: {
                  ...meta,
                  evolution_instance: instance,
                  last_evolution_state: evState,
                  tick_reconciled_at: new Date().toISOString(),
                },
              }).eq("id", conn.id);
            }
            if (realStatus === "online") {
              await persistSessionSnapshot(supabaseAdmin, conn.id, {
                instanceName: instance,
                status: "online",
                state: evState,
              }).catch(() => null);

              // -------- Watchdog anti-trava (Baileys 515 + pre-keys) --------
              // Cooldown é POR INSTÂNCIA (via metadata da connection) — outras
              // instâncias não param se uma travar.
              // Backoff EXPONENCIAL entre restarts que não resolvem:
              //   fails=0 → base, fails=1 → 2×, fails=2 → 4×, ... limitado a 6×.
              // Chama SOMENTE evolution.restart() — nunca logout — para preservar
              // a sessão pareada sem exigir novo QR.
              const meta = (conn.metadata as Record<string, any> | null) ?? {};
              const now = Date.now();
              const probeInterval = Number(process.env.WATCHDOG_INTERVAL_MS ?? 600_000);
              const baseCooldown = Number(process.env.WATCHDOG_RESTART_COOLDOWN_MS ?? 600_000);
              const failCount = Number(meta.watchdog_fail_count ?? 0);
              const backoffMult = Math.min(2 ** failCount, 8); // cap 8×
              const restartCooldown = baseCooldown * backoffMult;
              const lastProbe = Date.parse(meta.watchdog_last_check_at ?? "") || 0;
              const lastRestart = Date.parse(meta.watchdog_restart_at ?? "") || 0;
              if (
                !activeMigrationConnectionIds.has(conn.id) &&
                String(process.env.WATCHDOG_ACTIVE_PROBE ?? "").toLowerCase() === "true" &&
                now - lastProbe > probeInterval
              ) {
                const alive = await evolution.canReadSession(instance).catch(() => false);
                const patch: Record<string, any> = {
                  ...meta,
                  evolution_instance: instance,
                  watchdog_last_check_at: new Date().toISOString(),
                  watchdog_last_alive: alive,
                };
                if (alive) {
                  patch.watchdog_fail_count = 0;
                } else if (now - lastRestart > restartCooldown) {
                  let restartErr: unknown = null;
                  try {
                    // AUDIT: RESTART automático — não é logout, sessão preservada.
                    await evolution.restart(instance);
                  } catch (e) { restartErr = e; }
                  const { extractEvolutionErrorCode } = await import("@/lib/evolution.server");
                  const errCode = extractEvolutionErrorCode(restartErr ?? evState);
                  patch.watchdog_restart_at = new Date().toISOString();
                  patch.watchdog_restart_reason = "unresponsive_but_online";
                  patch.watchdog_fail_count = failCount + 1;
                  patch.watchdog_last_error_code = errCode;
                  patch.watchdog_next_backoff_ms = baseCooldown * Math.min(2 ** (failCount + 1), 8);
                  console.warn(`[watchdog] restart instância ${instance} (fails=${failCount + 1}, code=${errCode})`);
                  try {
                    await supabaseAdmin.from("audit_logs").insert({
                      user_id: (conn as any).user_id ?? null,
                      action: "whatsapp_watchdog_restart",
                      entity: "connection",
                      entity_id: conn.id,
                      metadata: {
                        instance,
                        error_code: errCode,
                        error_message: restartErr instanceof Error ? restartErr.message : String(restartErr ?? ""),
                        fail_count: failCount + 1,
                        next_backoff_ms: patch.watchdog_next_backoff_ms,
                        evolution_state: evState,
                      },
                    });
                  } catch { /* audit best-effort */ }
                }
                await supabaseAdmin.from("connections").update({ metadata: patch }).eq("id", conn.id);
              }
            }
          } catch { /* ignora falha transitória */ }
        }

        // Loop com orçamento de tempo — processa quantas ações estiverem
        // devidas dentro da janela do tick. Assim, quando o usuário configura
        // min/max_delay_seconds baixos, o disparo NÃO fica preso a 1 msg/min.
        //
        // Ajustáveis via variáveis de ambiente do worker:
        //   TICK_BUDGET_MS       (default 25000) — tempo máximo por tick
        //   TICK_RECOVERY_MS     (default 10000) — retry após reconexão
        //   TICK_MIGRATION_RETRY_MS (default 20000) — retry migração após erro
        const budgetMs = Number(process.env.TICK_BUDGET_MS ?? 8_000);
        const recoveryMs = Number(process.env.TICK_RECOVERY_MS ?? 15_000);
        // CORREÇÃO: migRetryMs aumentado de 20s para 35s.
        // Após um erro de migração, o Baileys precisa de mais tempo para
        // estabilizar o WebSocket antes da próxima tentativa de add.
        const migRetryMs = Number(process.env.TICK_MIGRATION_RETRY_MS ?? 35_000);
        const deadline = Date.now() + Math.max(2_000, budgetMs);
        const { processGroupMigrationBatch } = await import("@/lib/migrations.server");
        const migResults: any[] = [];
        const migrationConnectionsTouched = new Set<string>();

        let pass = 0;
        const maxPasses = Number(process.env.TICK_MAX_PASSES ?? 3);
        while (Date.now() < deadline && pass < maxPasses) {
          pass++;
          let didWork = false;
          const nowIsoPass = new Date().toISOString();

          // -------- Broadcasts em execução --------
          const { data: running } = await supabaseAdmin.from("broadcasts")
            .select("id,user_id,connection_id,template,min_delay_seconds,max_delay_seconds,sent_count,failed_count")
            .eq("status", "running");

          for (const bc of running ?? []) {
            if (Date.now() >= deadline) break;
            if (activeMigrationConnectionIds.has(bc.connection_id)) continue;
            const { data: conn } = await supabaseAdmin.from("connections")
              .select("status,metadata").eq("id", bc.connection_id).maybeSingle();
            if (!conn) continue;
            const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(bc.connection_id).replace(/-/g, "")}`;

            if (conn.status !== "online") {
              if ((conn.metadata as any)?.evolution_state === "reauth_required") continue;
              await supabaseAdmin.from("connections").update({
                status: "connecting",
                last_sync_at: new Date().toISOString(),
                metadata: {
                  ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                  evolution_instance: instance,
                  evolution_state: "send_waiting_for_online",
                  auto_reconnect_at: new Date().toISOString(),
                },
              }).eq("id", bc.connection_id);
              continue;
            }

            const { data: due } = await supabaseAdmin.from("broadcast_targets")
              .select("*").eq("broadcast_id", bc.id).eq("status", "pending")
              .lte("next_attempt_at", nowIsoPass).order("next_attempt_at").limit(1);
            const t = due?.[0];
            if (!t) {
              const { count: pending } = await supabaseAdmin.from("broadcast_targets")
                .select("id", { count: "exact", head: true }).eq("broadcast_id", bc.id).eq("status", "pending");
              if ((pending ?? 0) === 0) {
                await supabaseAdmin.from("broadcasts").update({
                  status: "completed", finished_at: new Date().toISOString(),
                }).eq("id", bc.id);
                didWork = true;
              }
              continue;
            }

            await supabaseAdmin.from("broadcast_targets").update({ status: "sending" }).eq("id", t.id);
            const body = (bc.template as string).replace(/\{(\w+)\}/g, (_, k) => {
              if (k === "nome" || k === "name") return t.name ?? "";
              if (k === "telefone") return t.phone ?? "";
              return "";
            });
            try {
              await evolution.sendText(instance, t.phone, body);
              await supabaseAdmin.from("broadcast_targets").update({
                status: "sent", sent_at: new Date().toISOString(),
              }).eq("id", t.id);
              await supabaseAdmin.from("broadcasts").update({ sent_count: (bc.sent_count ?? 0) + 1 }).eq("id", bc.id);
              summary.broadcasts++;
              didWork = true;
            } catch (e: any) {
              if (isPairingLostEvolutionError(e)) {
                await supabaseAdmin.from("broadcast_targets").update({
                  status: "pending",
                  error: REAUTH_REQUIRED_MESSAGE,
                }).eq("id", t.id);
                await markConnectionReauthRequired(supabaseAdmin, {
                  connectionId: bc.connection_id,
                  instanceName: instance,
                  reason: String(e?.message ?? "device_removed"),
                });
                summary.reauthPaused++;
                didWork = true;
                continue;
              }
              if (isTransientEvolutionError(e)) {
                await supabaseAdmin.from("connections").update({
                  status: "connecting",
                  last_sync_at: new Date().toISOString(),
                  metadata: {
                    ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                    evolution_instance: instance,
                    evolution_state: "transient_send_backoff_no_restart",
                    auto_reconnect_at: new Date().toISOString(),
                  },
                }).eq("id", bc.connection_id);
                await supabaseAdmin.from("broadcast_targets").update({
                  status: "pending",
                  next_attempt_at: new Date(Date.now() + recoveryMs).toISOString(),
                  error: "Reconectando WhatsApp sem novo QR; alvo mantido na fila",
                }).eq("id", t.id);
                didWork = true;
                continue;
              }
              await supabaseAdmin.from("broadcast_targets").update({
                status: "failed", error: String(e?.message ?? "erro"),
              }).eq("id", t.id);
              await supabaseAdmin.from("broadcasts").update({ failed_count: (bc.failed_count ?? 0) + 1 }).eq("id", bc.id);
              summary.errors++;
              didWork = true;
            }

            const min = bc.min_delay_seconds ?? 8, max = bc.max_delay_seconds ?? 45;
            const delaySec = Math.floor(min + Math.random() * (max - min + 1));
            const nextAt = new Date(Date.now() + delaySec * 1000).toISOString();
            const { data: nextRow } = await supabaseAdmin.from("broadcast_targets")
              .select("id").eq("broadcast_id", bc.id).eq("status", "pending")
              .order("next_attempt_at").limit(1).maybeSingle();
            if (nextRow) {
              await supabaseAdmin.from("broadcast_targets")
                .update({ next_attempt_at: nextAt }).eq("id", nextRow.id);
            }
          }

          if (Date.now() >= deadline) break;

          // -------- Agendadas devidas --------
          const scheduledLimit = Number(process.env.TICK_SCHEDULED_LIMIT ?? 5);
          const { data: sched } = await supabaseAdmin.from("scheduled_messages")
            .select("*").eq("status", "pending").lte("scheduled_at", nowIsoPass).order("scheduled_at").limit(scheduledLimit);

          for (const row of sched ?? []) {
            if (Date.now() >= deadline) break;
            if (activeMigrationConnectionIds.has(row.connection_id)) continue;
            const { data: conn } = await supabaseAdmin.from("connections")
              .select("status,metadata").eq("id", row.connection_id).maybeSingle();
            if (!conn) continue;
            const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(row.connection_id).replace(/-/g, "")}`;
            if (conn.status !== "online") {
              if ((conn.metadata as any)?.evolution_state === "reauth_required") continue;
              await supabaseAdmin.from("connections").update({
                status: "connecting",
                last_sync_at: new Date().toISOString(),
                metadata: {
                  ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                  evolution_instance: instance,
                  evolution_state: "scheduled_waiting_for_online",
                  auto_reconnect_at: new Date().toISOString(),
                },
              }).eq("id", row.connection_id);
              continue;
            }
            try {
              await evolution.sendText(instance, row.target, row.body);
              await supabaseAdmin.from("scheduled_messages").update({
                status: "sent", sent_at: new Date().toISOString(), attempts: (row.attempts ?? 0) + 1,
              }).eq("id", row.id);
              summary.scheduled++;
              didWork = true;
              if (row.recurrence === "daily" || row.recurrence === "weekly") {
                const step = row.recurrence === "daily" ? 1 : 7;
                const nextAt = new Date(new Date(row.scheduled_at).getTime() + step * 86400_000).toISOString();
                await supabaseAdmin.from("scheduled_messages").insert({
                  user_id: row.user_id, connection_id: row.connection_id,
                  target_kind: row.target_kind, target: row.target, target_label: row.target_label,
                  body: row.body, scheduled_at: nextAt, recurrence: row.recurrence, status: "pending",
                });
              }
            } catch (e: any) {
              if (isPairingLostEvolutionError(e)) {
                await supabaseAdmin.from("scheduled_messages").update({
                  status: "pending",
                  last_error: REAUTH_REQUIRED_MESSAGE,
                  attempts: (row.attempts ?? 0) + 1,
                }).eq("id", row.id);
                await markConnectionReauthRequired(supabaseAdmin, {
                  connectionId: row.connection_id,
                  instanceName: instance,
                  reason: String(e?.message ?? "device_removed"),
                });
                summary.reauthPaused++;
                didWork = true;
                continue;
              }
              if (isTransientEvolutionError(e)) {
                await supabaseAdmin.from("connections").update({
                  status: "connecting",
                  last_sync_at: new Date().toISOString(),
                  metadata: {
                    ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                    evolution_instance: instance,
                    evolution_state: "transient_scheduled_backoff_no_restart",
                    auto_reconnect_at: new Date().toISOString(),
                  },
                }).eq("id", row.connection_id);
                await supabaseAdmin.from("scheduled_messages").update({
                  status: "pending",
                  scheduled_at: new Date(Date.now() + recoveryMs).toISOString(),
                  last_error: "Reconectando WhatsApp sem novo QR; envio será tentado novamente",
                  attempts: (row.attempts ?? 0) + 1,
                }).eq("id", row.id);
                didWork = true;
                continue;
              }
              await supabaseAdmin.from("scheduled_messages").update({
                status: "failed", last_error: String(e?.message ?? "erro"), attempts: (row.attempts ?? 0) + 1,
              }).eq("id", row.id);
              summary.errors++;
              didWork = true;
            }
          }

          if (Date.now() >= deadline) break;

          // -------- Migrações de grupo devidas --------
          const { data: migs } = await supabaseAdmin.from("group_migrations")
            .select("id,connection_id").eq("status", "running").lte("next_attempt_at", nowIsoPass).limit(5);
          for (const m of migs ?? []) {
            if (Date.now() >= deadline) break;
            if (migrationConnectionsTouched.has(m.connection_id)) continue;
            migrationConnectionsTouched.add(m.connection_id);
            try {
              const r = await processGroupMigrationBatch(supabaseAdmin, m.id);
              migResults.push(r);
              if (!r?.skipped) didWork = true;
            } catch (e: any) {
              summary.errors++;
              await supabaseAdmin.from("group_migrations").update({
                last_error: String(e?.message ?? "erro"),
                next_attempt_at: new Date(Date.now() + migRetryMs).toISOString(),
              }).eq("id", m.id);
              didWork = true;
            }
          }

          if (!didWork) break;
        }


        return Response.json({ ok: true, ...summary, migrations: migResults, at: nowIso });
      },
    },
  },
});
