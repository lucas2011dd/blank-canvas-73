// Persistência de sessão por instância WhatsApp.
// Toda vez que a Evolution reporta a instância como "online" (via tick,
// webhook, sync ou reconexão manual) capturamos os metadados essenciais
// (ownerJid, state, timestamps, contatos/chats/grupos vistos) em
// `public.connection_sessions` e refletimos em `connections.session_snapshot`.
// Isso permite reconexão automática silenciosa 24/7 sem depender de novo QR,
// e garante que a sessão só cai em definitivo quando o usuário clica em
// "Desconectar" (grava `disconnected_manually = true`).

import type { SupabaseClient } from "@supabase/supabase-js";

export type SessionSnapshotInput = {
  instanceName: string;
  status: "online" | "offline" | "connecting";
  state?: string;
  ownerJid?: string | null;
  extra?: Record<string, unknown>;
};

type AdminOrUserClient = SupabaseClient<any, any, any>;

async function loadConnection(client: AdminOrUserClient, connectionId: string) {
  const { data } = await client
    .from("connections")
    .select("id,user_id,metadata,session_snapshot,evolution_owner_jid")
    .eq("id", connectionId)
    .maybeSingle();
  return data as
    | {
        id: string;
        user_id: string;
        metadata: Record<string, unknown> | null;
        session_snapshot: Record<string, unknown> | null;
        evolution_owner_jid: string | null;
      }
    | null;
}

export async function persistSessionSnapshot(
  client: AdminOrUserClient,
  connectionId: string,
  input: SessionSnapshotInput,
): Promise<void> {
  const conn = await loadConnection(client, connectionId);
  if (!conn) return;

  const now = new Date().toISOString();
  const meta = { ...((conn.metadata as Record<string, unknown> | null) ?? {}) };
  const prevSnap = (conn.session_snapshot as Record<string, unknown> | null) ?? {};

  const snapshot: Record<string, unknown> = {
    ...prevSnap,
    ...(input.extra ?? {}),
    instance_name: input.instanceName,
    status: input.status,
    state: input.state ?? input.status,
    owner_jid: input.ownerJid ?? (prevSnap.owner_jid as string | undefined) ?? conn.evolution_owner_jid ?? null,
    updated_at: now,
    ...(input.status === "online" ? { last_online_at: now } : {}),
  };

  const patch: Record<string, unknown> = {
    session_snapshot: snapshot,
    evolution_instance: input.instanceName,
    metadata: {
      ...meta,
      evolution_instance: input.instanceName,
      evolution_state: input.state ?? input.status,
      ...(input.ownerJid ? { evolution_owner_jid: input.ownerJid } : {}),
    },
  };
  if (input.ownerJid) patch.evolution_owner_jid = input.ownerJid;
  if (input.status === "online") patch.last_seen_online_at = now;

  await client.from("connections").update(patch).eq("id", connectionId);

  await client.from("connection_sessions").upsert(
    {
      connection_id: connectionId,
      user_id: conn.user_id,
      instance_name: input.instanceName,
      owner_jid: (snapshot.owner_jid as string | null | undefined) ?? null,
      state: input.state ?? null,
      status: input.status,
      snapshot,
      captured_at: now,
    },
    { onConflict: "connection_id,instance_name" },
  );
}

export async function markManualDisconnect(
  client: AdminOrUserClient,
  connectionId: string,
): Promise<void> {
  await client
    .from("connections")
    .update({
      disconnected_manually: true,
      auto_reconnect: false,
      status: "offline",
      qr_code: null,
    })
    .eq("id", connectionId);
}

export async function clearManualDisconnect(
  client: AdminOrUserClient,
  connectionId: string,
): Promise<void> {
  await client
    .from("connections")
    .update({ disconnected_manually: false, auto_reconnect: true })
    .eq("id", connectionId);
}
