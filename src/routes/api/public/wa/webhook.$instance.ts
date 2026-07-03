// Webhook público da Evolution API — ASSÍNCRONO.
// Formato: byEvents=false → único endpoint por instância.
// URL: /api/public/wa/webhook/:instance
//
// Aqui NÃO fazemos processamento pesado. Só:
//   1) autentica o header `apikey` (fail-closed)
//   2) grava o evento cru em `webhook_logs`
//   3) responde 200 imediatamente
//
// O processamento acontece no /api/public/wa/tick, que drena a fila com
// retry/backoff exponencial. Isso impede a Evolution de bloquear a sessão
// esperando 30s pelo Supabase (causa raiz de `device_removed`).
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
        if (!payload) return new Response("ok"); // ACK, nada a enfileirar

        const event: string = String(payload.event ?? "unknown");
        const data = payload.data ?? {};
        const instanceName = params.instance;

        // Grava e responde. Se o insert falhar, ainda respondemos 200 para
        // não travar a Evolution — o webhook é best-effort e a reconciliação
        // completa acontece no tick via /instance/fetchInstances.
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          await supabaseAdmin.from("webhook_logs").insert({
            instance_name: instanceName,
            event,
            payload: { event, data },
          });
        } catch (e) {
          console.error("[wa webhook] enqueue failed", e);
        }

        return new Response("ok");
      },
    },
  },
});
