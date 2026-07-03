// Endpoint público para "tick" de processamento — chame periodicamente via
// cron externo (p.ex. cron-job.org a cada 1min):
//   GET https://SEU-DOMINIO/api/public/wa/tick
//   Header: X-Tick-Secret: XXX
// Protegido por TICK_SECRET. O segredo é aceito APENAS via header
// para não vazar em logs de proxy/CDN/referrer.
import { createFileRoute } from "@tanstack/react-router";

// Rate limit simples em memória (por IP): 60 req/min.
const RATE: Map<string, { count: number; reset: number }> = (globalThis as any).__tickRate ??= new Map();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = RATE.get(ip);
  if (!bucket || bucket.reset < now) { RATE.set(ip, { count: 1, reset: now + 60_000 }); return false; }
  bucket.count++;
  return bucket.count > 60;
}

function webhookUrl(instanceName: string): string | undefined {
  const previewHost = process.env.LOVABLE_PREVIEW_HOST;
  const previewBase = previewHost ? `https://${previewHost}` : undefined;
  const configuredBase = process.env.WHATSAPP_WEBHOOK_PUBLIC_URL ?? process.env.APP_PUBLIC_URL;
  // Em preview, a URL project--*.lovable.app ainda não existe e responde 404.
  // Prefira o host id-preview--* para a Evolution entregar webhooks de verdade.
  const configuredPointsToUnpublishedHost = /\/\/project--[^/]+\.lovable\.app/i.test(configuredBase ?? "");
  const base = configuredPointsToUnpublishedHost && previewBase
    ? previewBase
    : (configuredBase ?? previewBase);
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/api/public/wa/webhook/${instanceName}`;
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
        const summary = { broadcasts: 0, scheduled: 0, errors: 0 };

        // Repara webhooks e reconcilia o status real da Evolution (evita ficar
        // "connecting" quando o celular já apareceu como conectado).
        const { data: webhookConns } = await supabaseAdmin.from("connections")
          .select("id,status,metadata")
          .eq("provider", "whatsapp")
          .in("status", ["online", "connecting"])
          .limit(20);
        const { isTransientEvolutionError, reconnectEvolutionSession, resolveEvolutionStatus } = await import("@/lib/evolution.server");
        for (const conn of webhookConns ?? []) {
          const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(conn.id).replace(/-/g, "")}`;
          const wh = webhookUrl(instance);
          if (wh) await evolution.setWebhook(instance, wh).catch(() => null);
          try {
            const resolved = await resolveEvolutionStatus(instance);
            const evState = resolved.state;
            const realStatus = resolved.status;
            if (realStatus !== conn.status) {
              await supabaseAdmin.from("connections").update({
                status: realStatus,
                ...(realStatus === "online" ? { qr_code: null } : {}),
                last_sync_at: new Date().toISOString(),
                metadata: {
                  ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                  evolution_instance: instance,
                  evolution_state: evState,
                  reconciled_at: new Date().toISOString(),
                },
              }).eq("id", conn.id);
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
        const budgetMs = Number(process.env.TICK_BUDGET_MS ?? 25_000);
        const recoveryMs = Number(process.env.TICK_RECOVERY_MS ?? 10_000);
        const migRetryMs = Number(process.env.TICK_MIGRATION_RETRY_MS ?? 20_000);
        const deadline = Date.now() + Math.max(2_000, budgetMs);
        const { processGroupMigrationBatch } = await import("@/lib/migrations.server");
        const migResults: any[] = [];

        let pass = 0;
        while (Date.now() < deadline && pass < 500) {
          pass++;
          let didWork = false;
          const nowIsoPass = new Date().toISOString();

          // -------- Broadcasts em execução --------
          const { data: running } = await supabaseAdmin.from("broadcasts")
            .select("id,user_id,connection_id,template,min_delay_seconds,max_delay_seconds,sent_count,failed_count")
            .eq("status", "running");

          for (const bc of running ?? []) {
            if (Date.now() >= deadline) break;
            const { data: conn } = await supabaseAdmin.from("connections")
              .select("status,metadata").eq("id", bc.connection_id).maybeSingle();
            if (!conn) continue;
            const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(bc.connection_id).replace(/-/g, "")}`;

            if (conn.status !== "online") {
              const recovered = await reconnectEvolutionSession(instance, { attempts: 3, delayMs: 1_000 }).catch(() => null);
              await supabaseAdmin.from("connections").update({
                status: recovered?.status ?? "connecting",
                ...(recovered?.status === "online" ? { qr_code: null } : {}),
                last_sync_at: new Date().toISOString(),
                metadata: {
                  ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                  evolution_instance: instance,
                  evolution_state: recovered?.state ?? "reconnecting",
                  auto_reconnect_at: new Date().toISOString(),
                },
              }).eq("id", bc.connection_id);
              if (recovered?.status !== "online") continue;
              didWork = true;
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
              if (isTransientEvolutionError(e)) {
                const recovered = await reconnectEvolutionSession(instance, { attempts: 2, delayMs: 1_000 }).catch(() => null);
                await supabaseAdmin.from("connections").update({
                  status: recovered?.status ?? "connecting",
                  ...(recovered?.status === "online" ? { qr_code: null } : {}),
                  last_sync_at: new Date().toISOString(),
                  metadata: {
                    ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                    evolution_instance: instance,
                    evolution_state: recovered?.state ?? "reconnecting",
                    auto_reconnect_at: new Date().toISOString(),
                  },
                }).eq("id", bc.connection_id);
                await supabaseAdmin.from("broadcast_targets").update({
                  status: "pending",
                  next_attempt_at: new Date(Date.now() + recoveryMs).toISOString(),
                  last_error: "Reconectando WhatsApp sem novo QR; alvo mantido na fila",
                }).eq("id", t.id);
                didWork = true;
                continue;
              }
              await supabaseAdmin.from("broadcast_targets").update({
                status: "failed", last_error: String(e?.message ?? "erro"),
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
          const { data: sched } = await supabaseAdmin.from("scheduled_messages")
            .select("*").eq("status", "pending").lte("scheduled_at", nowIsoPass).order("scheduled_at").limit(20);

          for (const row of sched ?? []) {
            if (Date.now() >= deadline) break;
            const { data: conn } = await supabaseAdmin.from("connections")
              .select("status,metadata").eq("id", row.connection_id).maybeSingle();
            if (!conn) continue;
            const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(row.connection_id).replace(/-/g, "")}`;
            if (conn.status !== "online") {
              const recovered = await reconnectEvolutionSession(instance, { attempts: 3, delayMs: 1_000 }).catch(() => null);
              await supabaseAdmin.from("connections").update({
                status: recovered?.status ?? "connecting",
                ...(recovered?.status === "online" ? { qr_code: null } : {}),
                last_sync_at: new Date().toISOString(),
                metadata: {
                  ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                  evolution_instance: instance,
                  evolution_state: recovered?.state ?? "reconnecting",
                  auto_reconnect_at: new Date().toISOString(),
                },
              }).eq("id", row.connection_id);
              if (recovered?.status !== "online") continue;
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
              if (isTransientEvolutionError(e)) {
                const recovered = await reconnectEvolutionSession(instance, { attempts: 2, delayMs: 1_000 }).catch(() => null);
                await supabaseAdmin.from("connections").update({
                  status: recovered?.status ?? "connecting",
                  ...(recovered?.status === "online" ? { qr_code: null } : {}),
                  last_sync_at: new Date().toISOString(),
                  metadata: {
                    ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                    evolution_instance: instance,
                    evolution_state: recovered?.state ?? "reconnecting",
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
            .select("id").eq("status", "running").lte("next_attempt_at", nowIsoPass).limit(5);
          for (const m of migs ?? []) {
            if (Date.now() >= deadline) break;
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
