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

        // -------- Broadcasts em execução --------
        const { data: running } = await supabaseAdmin.from("broadcasts")
          .select("id,user_id,connection_id,template,min_delay_seconds,max_delay_seconds,sent_count,failed_count")
          .eq("status", "running");

        for (const bc of running ?? []) {
          const { data: conn } = await supabaseAdmin.from("connections")
            .select("status,metadata").eq("id", bc.connection_id).maybeSingle();
          if (!conn || conn.status !== "online") continue;
          const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(bc.connection_id).replace(/-/g, "")}`;

          // Pega 1 alvo devido por broadcast a cada tick (paralelismo controlado)
          const { data: due } = await supabaseAdmin.from("broadcast_targets")
            .select("*").eq("broadcast_id", bc.id).eq("status", "pending")
            .lte("next_attempt_at", nowIso).order("next_attempt_at").limit(1);
          const t = due?.[0];
          if (!t) {
            const { count: pending } = await supabaseAdmin.from("broadcast_targets")
              .select("id", { count: "exact", head: true }).eq("broadcast_id", bc.id).eq("status", "pending");
            if ((pending ?? 0) === 0) {
              await supabaseAdmin.from("broadcasts").update({
                status: "completed", finished_at: new Date().toISOString(),
              }).eq("id", bc.id);
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
          } catch (e: any) {
            await supabaseAdmin.from("broadcast_targets").update({
              status: "failed", last_error: String(e?.message ?? "erro"),
            }).eq("id", t.id);
            await supabaseAdmin.from("broadcasts").update({ failed_count: (bc.failed_count ?? 0) + 1 }).eq("id", bc.id);
            summary.errors++;
          }

          // Programa o próximo alvo com delay aleatório (min..max seg)
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

        // -------- Agendadas devidas --------
        const { data: sched } = await supabaseAdmin.from("scheduled_messages")
          .select("*").eq("status", "pending").lte("scheduled_at", nowIso).order("scheduled_at").limit(20);

        for (const row of sched ?? []) {
          const { data: conn } = await supabaseAdmin.from("connections")
            .select("status,metadata").eq("id", row.connection_id).maybeSingle();
          if (!conn || conn.status !== "online") continue;
          const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(row.connection_id).replace(/-/g, "")}`;
          try {
            await evolution.sendText(instance, row.target, row.body);
            await supabaseAdmin.from("scheduled_messages").update({
              status: "sent", sent_at: new Date().toISOString(), attempts: (row.attempts ?? 0) + 1,
            }).eq("id", row.id);
            summary.scheduled++;
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
            await supabaseAdmin.from("scheduled_messages").update({
              status: "failed", last_error: String(e?.message ?? "erro"), attempts: (row.attempts ?? 0) + 1,
            }).eq("id", row.id);
            summary.errors++;
          }
        }

        // -------- Migrações de grupo devidas --------
        const { processGroupMigrationBatch } = await import("@/lib/migrations.server");
        const { data: migs } = await supabaseAdmin.from("group_migrations")
          .select("id").eq("status", "running").lte("next_attempt_at", nowIso).limit(5);
        const migResults: any[] = [];
        for (const m of migs ?? []) {
          try {
            const r = await processGroupMigrationBatch(supabaseAdmin, m.id);
            migResults.push(r);
          } catch (e: any) {
            summary.errors++;
            await supabaseAdmin.from("group_migrations").update({
              last_error: String(e?.message ?? "erro"),
              next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
            }).eq("id", m.id);
          }
        }

        return Response.json({ ok: true, ...summary, migrations: migResults, at: nowIso });
      },
    },
  },
});
