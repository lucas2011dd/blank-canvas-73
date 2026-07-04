// Processador da fila `webhook_logs`. Executado no /api/public/wa/tick,
// nunca no caminho crítico do webhook. Mantém a mesma lógica que existia
// inline no endpoint — só que agora fora do timeout de 30s da Evolution.
import type { SupabaseClient } from "@supabase/supabase-js";

const BULK_FAST_ACK_EVENTS = new Set([
  "contacts.upsert", "CONTACTS_UPSERT",
  "contacts.update", "CONTACTS_UPDATE",
  "chats.update",    "CHATS_UPDATE",
  "groups.upsert",   "GROUPS_UPSERT",
  "group-participants.update", "GROUP_PARTICIPANTS_UPDATE",
  "messages.set",    "MESSAGES_SET",
  "messages.update", "MESSAGES_UPDATE",
  "presence.update", "PRESENCE_UPDATE",
]);

async function handleEvent(
  admin: SupabaseClient,
  instanceName: string,
  event: string,
  data: any,
): Promise<void> {
  const { data: conn } = await admin.from("connections")
    .select("id,user_id,status,metadata")
    .eq("metadata->>evolution_instance", instanceName)
    .maybeSingle();
  if (!conn) return;

  if (event === "connection.update" || event === "CONNECTION_UPDATE") {
    const { extractEvolutionConnectionState, evolutionStateToStatus } = await import("@/lib/evolution.server");
    const state = extractEvolutionConnectionState(data) ?? data.state ?? data.status ?? "";
    const status = evolutionStateToStatus(state);
    const reason = String(data.statusReason ?? data.reason ?? "").toLowerCase();
    const stateAndReason = `${state} ${reason}`.toLowerCase();
    const explicitDeviceRemoved = /device[_ ]?removed|logged?[_ ]?out|logout|unpaired/i.test(stateAndReason);
    let deviceRemoved = explicitDeviceRemoved;

    if (status === "offline" || status === "connecting") {
      const [{ count: activeBroadcasts }, { count: activeMigrations }] = await Promise.all([
        admin.from("broadcasts").select("id", { count: "exact", head: true })
          .eq("connection_id", conn.id).eq("status", "running"),
        admin.from("group_migrations").select("id", { count: "exact", head: true })
          .eq("connection_id", conn.id).eq("status", "running"),
      ]);
      const hasActive = Boolean((activeBroadcasts ?? 0) + (activeMigrations ?? 0));
      const numericAuthDrop = /\b401\b/.test(reason);
      deviceRemoved = explicitDeviceRemoved || (!hasActive && numericAuthDrop);
      if (hasActive && !deviceRemoved) {
        const metaUpdate: Record<string, unknown> = {
          ...((conn.metadata as Record<string, unknown> | null) ?? {}),
          evolution_instance: instanceName,
          evolution_state: "migration_transient_connection_update_ignored",
          last_connection_update_state: state,
          last_connection_update_reason: data.statusReason ?? data.reason ?? null,
          auto_reconnect_at: new Date().toISOString(),
        };
        delete metaUpdate.pairing_lost_at;
        delete metaUpdate.pairing_lost_reason;
        delete metaUpdate.device_removed_at;
        delete metaUpdate.status_reason;
        delete metaUpdate.disconnected_at;
        delete metaUpdate.last_evolution_error_code;
        await admin.from("connections").update({
          status: conn.status,
          qr_code: null,
          last_sync_at: new Date().toISOString(),
          metadata: metaUpdate,
        }).eq("id", conn.id);
        return;
      }
    }

    const metaUpdate: Record<string, unknown> = {
      ...((conn.metadata as Record<string, unknown> | null) ?? {}),
      evolution_instance: instanceName,
      evolution_state: state,
      status_reason: data.statusReason ?? data.reason ?? null,
      disconnected_at: status === "offline" ? new Date().toISOString() : null,
      ...(deviceRemoved ? { device_removed_at: new Date().toISOString() } : {}),
    };
    if (status === "online") {
      delete metaUpdate.pairing_lost_at;
      delete metaUpdate.pairing_lost_reason;
      delete metaUpdate.device_removed_at;
      delete metaUpdate.session_drop_count;
      delete metaUpdate.last_session_drop_at;
      delete metaUpdate.last_session_drop_reason;
      delete metaUpdate.status_reason;
      delete metaUpdate.disconnected_at;
    }

    await admin.from("connections").update({
      status,
      last_sync_at: new Date().toISOString(),
      metadata: metaUpdate,
      ...(status === "online" ? { qr_code: null, last_seen_online_at: new Date().toISOString() } : {}),
      ...(deviceRemoved ? { qr_code: null } : {}),
    }).eq("id", conn.id);

    if (status === "online") {
      const ownerJid = (data.wuid ?? data.owner ?? data.ownerJid ?? (data.instance as any)?.wuid ?? null) as string | null;
      const { persistSessionSnapshot } = await import("@/lib/session-store.server");
      await persistSessionSnapshot(admin, conn.id, {
        instanceName, status: "online", state, ownerJid,
        extra: { last_event: event },
      }).catch(() => null);
    }
    return;
  }

  if (event === "qrcode.updated" || event === "QRCODE_UPDATED") {
    if (conn.status === "online") return;
    const [{ count: activeBroadcasts }, { count: activeMigrations }] = await Promise.all([
      admin.from("broadcasts").select("id", { count: "exact", head: true })
        .eq("connection_id", conn.id).eq("status", "running"),
      admin.from("group_migrations").select("id", { count: "exact", head: true })
        .eq("connection_id", conn.id).eq("status", "running"),
    ]);
    const hasActive = Boolean((activeBroadcasts ?? 0) + (activeMigrations ?? 0));
    if (hasActive) {
      await admin.from("connections").update({
        status: "connecting", qr_code: null,
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...((conn.metadata as Record<string, unknown> | null) ?? {}),
          evolution_instance: instanceName,
          evolution_state: "qr_suppressed_during_automation",
          qr_suppressed_at: new Date().toISOString(),
        },
      }).eq("id", conn.id);
      return;
    }
    const { extractQrImage } = await import("@/lib/evolution.server");
    const qrImage = await extractQrImage(data);
    if (qrImage) {
      await admin.from("connections").update({
        qr_code: qrImage, status: "connecting",
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...((conn.metadata as Record<string, unknown> | null) ?? {}),
          evolution_instance: instanceName,
          evolution_state: "qr_required",
          disconnected_at: new Date().toISOString(),
        },
      }).eq("id", conn.id);
    }
    return;
  }

  if (event === "contacts.upsert" || event === "CONTACTS_UPSERT") {
    const list: any[] = Array.isArray(data) ? data : (data.contacts ?? []);
    if (list.length > 200) {
      // Dump histórico enorme: só marca; sync completo é sob demanda.
      await admin.from("connections").update({
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...((conn.metadata as Record<string, unknown> | null) ?? {}),
          evolution_instance: instanceName,
          contacts_upsert_deferred: list.length,
          contacts_upsert_deferred_at: new Date().toISOString(),
        },
      }).eq("id", conn.id);
      return;
    }
    const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
    for (const c of list) {
      const jid = String(c.remoteJid ?? c.id ?? c.jid ?? "");
      if (!jid) continue;
      if (jid.endsWith("@g.us")) {
        await admin.from("whatsapp_groups").upsert({
          user_id: conn.user_id, connection_id: conn.id, jid,
          subject: String(c.pushName ?? c.name ?? c.notify ?? "Grupo"),
          picture_url: c.profilePicUrl ?? null,
          metadata: { instance_id: c.instanceId ?? null },
        }, { onConflict: "connection_id,jid" });
        continue;
      }
      const phone = digits(jid.split("@")[0]);
      if (!phone) continue;
      const { data: exists } = await admin.from("contacts").select("id")
        .eq("user_id", conn.user_id).eq("phone", phone).maybeSingle();
      if (!exists) {
        await admin.from("contacts").insert({
          user_id: conn.user_id,
          name: String(c.pushName ?? c.name ?? c.notify ?? phone),
          phone, external_source: "whatsapp", external_id: jid,
        });
      }
    }
    return;
  }

  if (
    event === "chats.upsert"  || event === "CHATS_UPSERT" ||
    event === "groups.upsert" || event === "GROUPS_UPSERT"
  ) {
    const list: any[] = Array.isArray(data) ? data : (data.chats ?? data.groups ?? data.data ?? []);
    const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
    for (const ch of list) {
      const jid = String(ch.remoteJid ?? ch.id ?? ch.jid ?? "");
      if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
      if (jid.endsWith("@g.us")) {
        await admin.from("whatsapp_groups").upsert({
          user_id: conn.user_id, connection_id: conn.id, jid,
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
      const { data: existingConv } = await admin.from("conversations").select("id")
        .eq("user_id", conn.user_id).eq("connection_id", conn.id).eq("title", phone).maybeSingle();
      if (!existingConv) {
        await admin.from("conversations").insert({
          user_id: conn.user_id, connection_id: conn.id, title: phone,
          last_message_at: new Date().toISOString(),
        });
      }
    }
    return;
  }

  if (event === "messages.upsert" || event === "MESSAGES_UPSERT") {
    if (conn.status !== "online") {
      await admin.from("connections").update({
        status: "online", qr_code: null,
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...((conn.metadata as Record<string, unknown> | null) ?? {}),
          evolution_instance: instanceName,
          evolution_state: "capturing_messages",
        },
      }).eq("id", conn.id);
    }
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

    if (isGroup) {
      const { data: grp } = await admin.from("whatsapp_groups")
        .select("id,subject,monitored").eq("connection_id", conn.id).eq("jid", remoteJid).maybeSingle();
      if (!grp?.monitored) return;
      const title = `Grupo: ${grp.subject}`;
      const { data: existingConv } = await admin.from("conversations").select("id")
        .eq("user_id", conn.user_id).eq("connection_id", conn.id).eq("title", title).maybeSingle();
      let conversationId = existingConv?.id;
      if (!conversationId) {
        const { data: newConv } = await admin.from("conversations").insert({
          user_id: conn.user_id, connection_id: conn.id, title,
          last_message_at: new Date().toISOString(),
        }).select("id").single();
        conversationId = newConv?.id;
      }
      if (conversationId && body) {
        const sender = String(key.participant ?? "").split("@")[0];
        await admin.from("messages").insert({
          conversation_id: conversationId, user_id: conn.user_id,
          direction: fromMe ? "outbound" : "inbound",
          body: sender ? `[${sender}] ${body}` : body,
          status: "delivered",
        });
        await admin.from("conversations")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", conversationId);
      }
      return;
    }

    const { data: existingConv } = await admin.from("conversations").select("id")
      .eq("user_id", conn.user_id).eq("connection_id", conn.id).eq("title", phone).maybeSingle();
    let conversationId = existingConv?.id;
    if (!conversationId) {
      const { data: newConv } = await admin.from("conversations").insert({
        user_id: conn.user_id, connection_id: conn.id,
        title: phone || "WhatsApp",
        last_message_at: new Date().toISOString(),
      }).select("id").single();
      conversationId = newConv?.id;
    }
    if (conversationId && body) {
      await admin.from("messages").insert({
        conversation_id: conversationId, user_id: conn.user_id,
        direction: fromMe ? "outbound" : "inbound",
        body, status: "delivered",
      });
      await admin.from("conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", conversationId);
    }
    return;
  }

  // Eventos volumosos que só precisam de ACK — nada a processar aqui.
  if (BULK_FAST_ACK_EVENTS.has(event)) return;
}

/**
 * Consome até `limit` eventos pendentes da fila `webhook_logs`.
 * Rodado pelo /api/public/wa/tick. Retorna quantos foram processados.
 */
export async function drainWebhookQueue(
  admin: SupabaseClient,
  limit = 50,
  deadline = Date.now() + 15_000,
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;

  while (Date.now() < deadline && processed + failed < limit) {
    const nowIso = new Date().toISOString();
    const { data: rows } = await admin.from("webhook_logs")
      .select("id,instance_name,event,payload,attempts")
      .eq("status", "pending")
      .lte("next_attempt_at", nowIso)
      .order("id", { ascending: true })
      .limit(5);
    if (!rows?.length) break;

    for (const selected of rows) {
      if (Date.now() >= deadline) break;
      const { data: row } = await admin.from("webhook_logs")
        .update({ status: "processing" })
        .eq("id", selected.id)
        .eq("status", "pending")
        .lte("next_attempt_at", nowIso)
        .select("id,instance_name,event,payload,attempts")
        .maybeSingle();
      if (!row) continue;
      try {
        await handleEvent(admin, row.instance_name, row.event, row.payload);
        await admin.from("webhook_logs").update({
          status: "done",
          processed_at: new Date().toISOString(),
          attempts: (row.attempts ?? 0) + 1,
          last_error: null,
        }).eq("id", row.id);
        processed++;
      } catch (e: any) {
        const attempts = (row.attempts ?? 0) + 1;
        // Exponential backoff: 2s, 4s, 8s, 16s, ...  (cap 5min)
        const backoffMs = Math.min(2_000 * 2 ** (attempts - 1), 300_000);
        const giveUp = attempts >= 8;
        await admin.from("webhook_logs").update({
          status: giveUp ? "failed" : "pending",
          attempts,
          last_error: String(e?.message ?? e).slice(0, 500),
          next_attempt_at: new Date(Date.now() + backoffMs).toISOString(),
        }).eq("id", row.id);
        failed++;
      }
    }
  }

  return { processed, failed };
}
