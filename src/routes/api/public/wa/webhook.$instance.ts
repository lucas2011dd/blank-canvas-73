// Webhook público da Evolution API — ASSÍNCRONO com FAST-PATH.
//
// - CONNECTION_UPDATE é processado inline: assim detectamos a queda no ato
//   (em vez de esperar o próximo tick), registramos o código de erro exato
//   em `audit_logs` e disparamos as automações de segurança.
// - Demais eventos vão para a fila `webhook_logs` e são drenados no /tick.
// - Handler responde 200 sempre, mesmo em falha interna — não pode segurar
//   a Evolution 30s (causa raiz de device_removed).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/wa/webhook/$instance")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const expected = process.env.EVOLUTION_WEBHOOK_SECRET ?? process.env.EVOLUTION_API_KEY ?? "";
        const candidates = [
          request.headers.get("apikey"),
          request.headers.get("x-evolution-webhook-secret"),
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""),
        ].filter(Boolean);
        if (!expected || !candidates.includes(expected)) {
          return new Response("unauthorized", { status: 401 });
        }

        let payload: any = null;
        try {
          const raw = await request.text();
          payload = raw ? JSON.parse(raw) : null;
        } catch { /* ignore */ }
        if (!payload) return new Response("ok");

        const event: string = String(payload.event ?? "unknown");
        const data = payload.data ?? {};
        const instanceName = params.instance;

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

          // -------- FAST-PATH: CONNECTION_UPDATE processado inline --------
          if (event === "connection.update" || event === "CONNECTION_UPDATE") {
            const { extractEvolutionConnectionState, evolutionStateToStatus, extractEvolutionErrorCode } = await import("@/lib/evolution.server");
            const state = extractEvolutionConnectionState(data) ?? data.state ?? data.status ?? "";
            const status = evolutionStateToStatus(state);
            const errorCode = extractEvolutionErrorCode({ state, data });

            const { data: conn } = await supabaseAdmin.from("connections")
              .select("id,user_id,status,metadata")
              .eq("metadata->>evolution_instance", instanceName)
              .maybeSingle();

            if (conn) {
              // Auditoria da queda com código exato (515, 401, 428, ...).
              if (status !== "online") {
                try {
                  await supabaseAdmin.from("audit_logs").insert({
                    user_id: conn.user_id,
                    action: "whatsapp_connection_drop",
                    entity: "connection",
                    entity_id: conn.id,
                    metadata: {
                      instance: instanceName,
                      event, state, status,
                      error_code: errorCode,
                      status_reason: data.statusReason ?? data.reason ?? null,
                      detected_via: "webhook_fast_path",
                    },
                  });
                } catch { /* audit é best-effort */ }
              }

              const reason = String(data.statusReason ?? data.reason ?? errorCode ?? "").toLowerCase();
              const deviceRemoved = /device[_ ]?removed|logged?[_ ]?out|401/i.test(reason);

              // Durante migração ATIVA nesta conexão, não flipa `status` para
              // "connecting" em oscilações transitórias — o Baileys emite
              // CONNECTION_UPDATE várias vezes logo após addGroupParticipants
              // (close → connecting → open) e o flip fazia o próximo tick
              // reentrar no ramo offline e disparar handleSessionDrop sem
              // necessidade. Só flipa quando é claramente device_removed.
              const { data: activeMig } = await supabaseAdmin.from("group_migrations")
                .select("id")
                .eq("connection_id", conn.id)
                .eq("status", "running")
                .limit(1)
                .maybeSingle();
              const skipStatusFlip = !!activeMig && status !== "online" && !deviceRemoved;

              const nextStatus = skipStatusFlip
                ? conn.status
                : (status === "offline" && conn.status === "online" ? "connecting" : status);

              await supabaseAdmin.from("connections").update({
                status: nextStatus,
                last_sync_at: new Date().toISOString(),
                metadata: {
                  ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                  evolution_instance: instanceName,
                  evolution_state: state,
                  last_evolution_error_code: errorCode,
                  status_reason: data.statusReason ?? data.reason ?? null,
                  device_removed_at: deviceRemoved ? new Date().toISOString() : null,
                  connection_update_at: new Date().toISOString(),
                  ...(skipStatusFlip ? { migration_status_flip_skipped_at: new Date().toISOString() } : {}),
                },
                ...(status === "online" ? { qr_code: null, last_seen_online_at: new Date().toISOString() } : {}),
              }).eq("id", conn.id);
            }

          }

          // Sempre enfileira também — mantém histórico e o drainer roda a
          // reconciliação completa (session snapshot etc.) fora do caminho crítico.
          await supabaseAdmin.from("webhook_logs").insert({
            instance_name: instanceName,
            event,
            payload: { event, data },
          });
        } catch (e) {
          console.error("[wa webhook] processing failed", e);
        }

        return new Response("ok");
      },
    },
  },
});
