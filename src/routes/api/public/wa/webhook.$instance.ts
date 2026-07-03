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
        // FAIL-CLOSED: se nenhum segredo estiver configurado, rejeita.
        const expected = process.env.EVOLUTION_WEBHOOK_SECRET ?? process.env.EVOLUTION_API_KEY ?? "";
        const got =
          request.headers.get("apikey") ??
          request.headers.get("x-evolution-webhook-secret") ??
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
          "";
        if (!expected || got !== expected) {
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
          .select("id,user_id,status,metadata")
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
              metadata: {
                ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                evolution_instance: instanceName,
                evolution_state: state,
                status_reason: data.statusReason ?? data.reason ?? null,
                disconnected_at: status === "offline" ? new Date().toISOString() : null,
              },
              ...(status === "online" ? { qr_code: null } : {}),
            }).eq("id", conn.id);

            // Ao ficar online, dispara sincronização inicial em background.
            if (status === "online") {
              (async () => {
                try {
                  const { evolution } = await import("@/lib/evolution.server");
                  const [contactsRaw, chatsRaw, groupsRaw] = await Promise.all([
                    evolution.findContacts(instanceName),
                    evolution.findChats(instanceName),
                    evolution.fetchAllGroups(instanceName),
                  ]);
                  const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

                  const rows: any[] = [];
                  for (const c of contactsRaw ?? []) {
                    const jid = String(c.remoteJid ?? c.id ?? c.jid ?? "");
                    if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;
                    const phone = digits(jid.split("@")[0]);
                    if (!phone) continue;
                    rows.push({
                      user_id: conn.user_id,
                      name: String(c.pushName ?? c.name ?? c.notify ?? phone),
                      phone,
                      external_source: "whatsapp",
                      external_id: jid,
                    });
                  }
                  if (rows.length) {
                    const phones = Array.from(new Set(rows.map((r) => r.phone)));
                    const { data: existing } = await supabaseAdmin
                      .from("contacts").select("phone")
                      .eq("user_id", conn.user_id).in("phone", phones);
                    const has = new Set((existing ?? []).map((r: any) => r.phone));
                    const toInsert = rows.filter((r) => !has.has(r.phone));
                    if (toInsert.length) await supabaseAdmin.from("contacts").insert(toInsert);
                  }

                  for (const ch of chatsRaw ?? []) {
                    const jid = String(ch.remoteJid ?? ch.id ?? ch.jid ?? "");
                    if (!jid || jid.endsWith("@g.us") || jid.endsWith("@lid") || jid.endsWith("@newsletter") || jid === "status@broadcast") continue;
                    if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@c.us") && jid.includes("@")) continue;
                    const phone = digits(jid.split("@")[0]);
                    if (!phone || phone.length < 8 || phone.length > 15) continue;
                    const { data: exists } = await supabaseAdmin.from("conversations").select("id")
                      .eq("user_id", conn.user_id).eq("connection_id", conn.id).eq("title", phone).maybeSingle();
                    if (!exists) {
                      await supabaseAdmin.from("conversations").insert({
                        user_id: conn.user_id, connection_id: conn.id, title: phone,
                        last_message_at: new Date().toISOString(),
                      });
                    }
                  }

                  for (const g of groupsRaw ?? []) {
                    const jid = String(g.id ?? g.remoteJid ?? "");
                    if (!jid.endsWith("@g.us")) continue;
                    await supabaseAdmin.from("whatsapp_groups").upsert({
                      user_id: conn.user_id,
                      connection_id: conn.id,
                      jid,
                      subject: String(g.subject ?? g.name ?? "Grupo"),
                      description: g.desc ?? g.description ?? null,
                      participants_count: Array.isArray(g.participants) ? g.participants.length : (g.size ?? 0),
                      owner: g.owner ?? null,
                      picture_url: g.pictureUrl ?? null,
                    }, { onConflict: "connection_id,jid" });
                  }
                } catch (e) {
                  console.error("[wa webhook] auto-sync failed", e);
                }
              })();
            }
          } else if (event === "qrcode.updated" || event === "QRCODE_UPDATED") {
            const { extractQrImage } = await import("@/lib/evolution.server");
            const qrImage = await extractQrImage(data);
            if (qrImage) {
              await supabaseAdmin.from("connections").update({
                qr_code: qrImage, status: "connecting", last_sync_at: new Date().toISOString(),
              }).eq("id", conn.id);
            }
          } else if (event === "contacts.upsert" || event === "CONTACTS_UPSERT") {
            const list: any[] = Array.isArray(data) ? data : (data.contacts ?? []);
            const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
            for (const c of list) {
              const jid = String(c.remoteJid ?? c.id ?? c.jid ?? "");
              if (!jid) continue;
              if (jid.endsWith("@g.us")) {
                await supabaseAdmin.from("whatsapp_groups").upsert({
                  user_id: conn.user_id,
                  connection_id: conn.id,
                  jid,
                  subject: String(c.pushName ?? c.name ?? c.notify ?? "Grupo"),
                  picture_url: c.profilePicUrl ?? null,
                  metadata: { instance_id: c.instanceId ?? null },
                }, { onConflict: "connection_id,jid" });
                continue;
              }
              const phone = digits(jid.split("@")[0]);
              if (!phone) continue;
              const { data: exists } = await supabaseAdmin.from("contacts").select("id")
                .eq("user_id", conn.user_id).eq("phone", phone).maybeSingle();
              if (!exists) {
                await supabaseAdmin.from("contacts").insert({
                  user_id: conn.user_id,
                  name: String(c.pushName ?? c.name ?? c.notify ?? phone),
                  phone, external_source: "whatsapp", external_id: jid,
                });
              }
            }
          } else if (event === "chats.upsert" || event === "CHATS_UPSERT" || event === "groups.upsert" || event === "GROUPS_UPSERT") {
            const list: any[] = Array.isArray(data) ? data : (data.chats ?? data.groups ?? data.data ?? []);
            const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
            for (const ch of list) {
              const jid = String(ch.remoteJid ?? ch.id ?? ch.jid ?? "");
              if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
              if (jid.endsWith("@g.us")) {
                await supabaseAdmin.from("whatsapp_groups").upsert({
                  user_id: conn.user_id,
                  connection_id: conn.id,
                  jid,
                  subject: String(ch.subject ?? ch.pushName ?? ch.name ?? "Grupo"),
                  participants_count: Array.isArray(ch.participants) ? ch.participants.length : (ch.size ?? 0),
                  owner: ch.owner ?? null,
                  picture_url: ch.pictureUrl ?? ch.profilePicUrl ?? null,
                  metadata: { instance_id: ch.instanceId ?? null },
                }, { onConflict: "connection_id,jid" });
                continue;
              }
              const phone = digits(jid.split("@")[0]);
              if (!phone || phone.length < 8 || phone.length > 15) continue;
              const { data: existingConv } = await supabaseAdmin.from("conversations").select("id")
                .eq("user_id", conn.user_id).eq("connection_id", conn.id).eq("title", phone).maybeSingle();
              if (!existingConv) {
                await supabaseAdmin.from("conversations").insert({
                  user_id: conn.user_id, connection_id: conn.id, title: phone,
                  last_message_at: new Date().toISOString(),
                });
              }
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
            const isGroup = remoteJid.endsWith("@g.us");
            const phone = remoteJid.split("@")[0] ?? "";

            // Para grupos: só cria/atualiza conversa se o grupo estiver marcado como monitorado.
            if (isGroup) {
              const { data: grp } = await supabaseAdmin.from("whatsapp_groups")
                .select("id,subject,monitored").eq("connection_id", conn.id).eq("jid", remoteJid).maybeSingle();
              if (!grp?.monitored) return new Response("ok");
              const title = `Grupo: ${grp.subject}`;
              const { data: existingConv } = await supabaseAdmin
                .from("conversations").select("id")
                .eq("user_id", conn.user_id).eq("connection_id", conn.id).eq("title", title).maybeSingle();
              let conversationId = existingConv?.id;
              if (!conversationId) {
                const { data: newConv } = await supabaseAdmin.from("conversations").insert({
                  user_id: conn.user_id, connection_id: conn.id, title,
                  last_message_at: new Date().toISOString(),
                }).select("id").single();
                conversationId = newConv?.id;
              }
              if (conversationId && body) {
                const sender = String(key.participant ?? "").split("@")[0];
                await supabaseAdmin.from("messages").insert({
                  conversation_id: conversationId, user_id: conn.user_id,
                  direction: fromMe ? "outbound" : "inbound",
                  body: sender ? `[${sender}] ${body}` : body,
                  status: "delivered",
                });
                await supabaseAdmin.from("conversations")
                  .update({ last_message_at: new Date().toISOString() })
                  .eq("id", conversationId);
              }
              return new Response("ok");
            }

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
