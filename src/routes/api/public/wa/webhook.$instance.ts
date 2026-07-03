// Webhook público da Evolution API.
// Formato configurado: byEvents=false → único endpoint por instância.
// URL: /api/public/wa/webhook/:instance
//
// Segurança: exigimos o header `apikey` igual a EVOLUTION_WEBHOOK_SECRET
// (ou, se não definido, à própria EVOLUTION_API_KEY — que a Evolution envia).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/wa/webhook/$instance")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const expected =
          process.env.EVOLUTION_WEBHOOK_SECRET ?? process.env.EVOLUTION_API_KEY ?? "";
        const got = request.headers.get("apikey") ?? "";
        if (expected && got !== expected) {
          return new Response("unauthorized", { status: 401 });
        }

        let payload: any = null;
        try { payload = await request.json(); } catch { /* ignore */ }
        if (!payload) return new Response("bad request", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const instanceName = params.instance;

        // Localiza a conexão pelo metadata.evolution_instance
        const { data: conn } = await supabaseAdmin
          .from("connections")
          .select("id,user_id,status")
          .eq("metadata->>evolution_instance", instanceName)
          .maybeSingle();
        if (!conn) return new Response("ok"); // nada a fazer

        const event: string = payload.event ?? "";
        const data = payload.data ?? {};

        try {
          if (event === "connection.update" || event === "CONNECTION_UPDATE") {
            const state = data.state ?? data.status ?? "";
            const status =
              state === "open" ? "online" :
              state === "connecting" ? "connecting" : "offline";
            await supabaseAdmin.from("connections").update({
              status, last_sync_at: new Date().toISOString(),
              ...(status === "online" ? { qr_code: null } : {}),
            }).eq("id", conn.id);
          } else if (event === "qrcode.updated" || event === "QRCODE_UPDATED") {
            const base64 = data.qrcode?.base64 ?? data.base64 ?? null;
            if (base64) {
              await supabaseAdmin.from("connections").update({
                qr_code: base64, status: "connecting", last_sync_at: new Date().toISOString(),
              }).eq("id", conn.id);
            }
          } else if (event === "messages.upsert" || event === "MESSAGES_UPSERT") {
            const msg = data.message ?? data;
            const key = data.key ?? msg?.key ?? {};
            const fromMe: boolean = key.fromMe === true;
            const remoteJid: string = String(key.remoteJid ?? "");
            const body: string =
              msg?.conversation ??
              msg?.extendedTextMessage?.text ??
              msg?.imageMessage?.caption ??
              msg?.videoMessage?.caption ??
              data.messageType ?? "";
            const phone = remoteJid.split("@")[0] ?? "";

            // Encontra/cria conversa
            const { data: existingConv } = await supabaseAdmin
              .from("conversations")
              .select("id")
              .eq("user_id", conn.user_id)
              .eq("connection_id", conn.id)
              .eq("title", phone)
              .maybeSingle();

            let conversationId = existingConv?.id;
            if (!conversationId) {
              const { data: newConv } = await supabaseAdmin
                .from("conversations")
                .insert({
                  user_id: conn.user_id,
                  connection_id: conn.id,
                  title: phone || "WhatsApp",
                  last_message_at: new Date().toISOString(),
                })
                .select("id").single();
              conversationId = newConv?.id;
            }

            if (conversationId && body) {
              await supabaseAdmin.from("messages").insert({
                conversation_id: conversationId,
                user_id: conn.user_id,
                direction: fromMe ? "outbound" : "inbound",
                body,
                status: "delivered",
              });
              await supabaseAdmin.from("conversations")
                .update({ last_message_at: new Date().toISOString() })
                .eq("id", conversationId);
            }
          }
        } catch (e) {
          console.error("[wa webhook] processing failed", e);
        }

        return new Response("ok");
      },
    },
  },
});
