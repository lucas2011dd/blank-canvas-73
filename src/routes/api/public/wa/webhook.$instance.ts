// Webhook público da Evolution API — ASSÍNCRONO com FAST-PATH.
//
// - CONNECTION_UPDATE é processado inline: assim detectamos a queda no ato
//   (em vez de esperar o próximo tick), registramos o código de erro exato
//   em `audit_logs` e disparamos as automações de segurança.
// - Demais eventos vão para a fila `webhook_logs` e são drenados no /tick.
// - Handler responde 200 sempre, mesmo em falha interna — não pode segurar
//   a Evolution 30s (causa raiz de device_removed).
import { createFileRoute } from "@tanstack/react-router";

const HEAVY_ACK_ONLY_EVENTS = new Set([
  "messages.set", "MESSAGES_SET",
  "messages.update", "MESSAGES_UPDATE",
  "presence.update", "PRESENCE_UPDATE",
  "chats.upsert", "CHATS_UPSERT",
  "chats.update", "CHATS_UPDATE",
  // Durante cada add em grupo, a Evolution/Baileys pode emitir payloads que
  // crescem com o tamanho do grupo. Processar/parsear/enfileirar isso é a
  // parte que fazia a VPS dar pico exatamente a cada catch. A migração não
  // depende desses eventos; o estado real vem do retorno do updateParticipant.
  "groups.upsert", "GROUPS_UPSERT",
  "groups.update", "GROUPS_UPDATE",
  "group-participants.update", "GROUP_PARTICIPANTS_UPDATE",
]);

const LARGE_DEFERABLE_EVENTS = new Set([
  "contacts.upsert", "CONTACTS_UPSERT",
  "contacts.update", "CONTACTS_UPDATE",
  "groups.upsert", "GROUPS_UPSERT",
  "group-participants.update", "GROUP_PARTICIPANTS_UPDATE",
]);

function extractEventFromRaw(raw: string): string | null {
  return raw.match(/"event"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

function listLength(value: any): number {
  if (Array.isArray(value)) return value.length;
  for (const key of ["contacts", "chats", "groups", "data", "participants"]) {
    if (Array.isArray(value?.[key])) return value[key].length;
  }
  return 0;
}

async function readBodyPreview(request: Request, limitBytes: number): Promise<{ text: string; exceeded: boolean; bytes: number }> {
  if (!request.body) {
    const text = await request.text();
    return { text, exceeded: false, bytes: text.length };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let exceeded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limitBytes) {
        exceeded = true;
        const remaining = Math.max(0, limitBytes - (bytes - value.byteLength));
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(concatBytes(chunks)), exceeded, bytes };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

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
        let raw = "";
        try {
          const maxRawBytes = Number(process.env.WEBHOOK_MAX_STORED_PAYLOAD_BYTES ?? 64_000);
          const body = await readBodyPreview(request, maxRawBytes);
          raw = body.text;
          const rawEvent = extractEventFromRaw(raw);
          if (rawEvent && HEAVY_ACK_ONLY_EVENTS.has(rawEvent)) {
            return new Response("ok");
          }
          if (body.exceeded) {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            await supabaseAdmin.from("webhook_logs").insert({
              instance_name: params.instance,
              event: rawEvent ?? "large_payload",
              payload: {
                event: rawEvent ?? "large_payload",
                data: {
                  bulk_deferred: true,
                  reason: "payload_too_large",
                  raw_bytes: body.bytes,
                },
              },
            }).catch(() => null);
            return new Response("ok");
          }
          payload = raw ? JSON.parse(raw) : null;
        } catch { /* ignore */ }
        if (!payload) return new Response("ok");

        const event: string = String(payload.event ?? "unknown");
        const data = payload.data ?? {};
        const instanceName = params.instance;

        if (HEAVY_ACK_ONLY_EVENTS.has(event)) {
          return new Response("ok");
        }

        const maxBulkItems = Number(process.env.WEBHOOK_MAX_BULK_ITEMS ?? 200);
        const itemCount = listLength(data);
        const shouldStoreSlimPayload = LARGE_DEFERABLE_EVENTS.has(event) && itemCount > maxBulkItems;

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
              const stateAndReason = `${state} ${reason}`.toLowerCase();
              const explicitDeviceRemoved = /device[_ ]?removed|logged?[_ ]?out|logout|unpaired/i.test(stateAndReason);

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
              // Durante migração, statusReason 401/515 pode ser só fechamento
              // transitório do stream Baileys logo após addGroupParticipants.
              // Só é perda real de pareamento se o payload disser explicitamente
              // device_removed/logout/unpaired. Fora de migração, 401 continua
              // sendo tratado como queda dura.
              const numericAuthDrop = /\b401\b/.test(reason);
              const deviceRemoved = explicitDeviceRemoved || (!activeMig && numericAuthDrop);
              const skipStatusFlip = !!activeMig && status !== "online" && !deviceRemoved;

              const nextStatus = skipStatusFlip
                ? conn.status
                : (status === "offline" && conn.status === "online" ? "connecting" : status);

              const metaUpdate: Record<string, unknown> = {
                ...((conn.metadata as Record<string, unknown> | null) ?? {}),
                evolution_instance: instanceName,
                evolution_state: state,
                last_evolution_error_code: errorCode,
                status_reason: data.statusReason ?? data.reason ?? null,
                connection_update_at: new Date().toISOString(),
                ...(deviceRemoved ? { device_removed_at: new Date().toISOString() } : {}),
                ...(skipStatusFlip ? { migration_status_flip_skipped_at: new Date().toISOString() } : {}),
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
              if (skipStatusFlip) {
                delete metaUpdate.pairing_lost_at;
                delete metaUpdate.pairing_lost_reason;
                delete metaUpdate.device_removed_at;
                delete metaUpdate.status_reason;
                delete metaUpdate.disconnected_at;
              }

              await supabaseAdmin.from("connections").update({
                status: nextStatus,
                last_sync_at: new Date().toISOString(),
                metadata: metaUpdate,
                ...(status === "online" ? { qr_code: null, last_seen_online_at: new Date().toISOString() } : {}),
              }).eq("id", conn.id);
            }

          }

          // Sempre enfileira também — mantém histórico e o drainer roda a
          // reconciliação completa (session snapshot etc.) fora do caminho crítico.
          await supabaseAdmin.from("webhook_logs").insert({
            instance_name: instanceName,
            event,
            payload: shouldStoreSlimPayload
              ? {
                  event,
                  data: {
                    bulk_deferred: true,
                    reason: "too_many_items",
                    item_count: itemCount,
                    raw_bytes: raw.length,
                  },
                }
              : { event, data },
          });
        } catch (e) {
          console.error("[wa webhook] processing failed", e);
        }

        return new Response("ok");
      },
    },
  },
});
