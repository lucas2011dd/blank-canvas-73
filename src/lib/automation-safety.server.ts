type DbClient = any;

export const REAUTH_REQUIRED_MESSAGE =
  "Sessão do WhatsApp removida/desconectada. As automações foram pausadas; clique em Reconectar e escaneie o QR para continuar.";

async function safeStep(label: string, action: () => PromiseLike<any>) {
  try {
    const result = await action();
    if (result?.error) console.error(`[automation-safety] ${label}:`, result.error.message ?? result.error);
    return result;
  } catch (error: any) {
    console.error(`[automation-safety] ${label}:`, error?.message ?? error);
    return null;
  }
}

export async function markConnectionReauthRequired(
  supabase: DbClient,
  args: { connectionId: string; userId?: string; instanceName?: string; reason?: string },
) {
  const now = new Date().toISOString();
  let connQuery = supabase
    .from("connections")
    .select("id,user_id,metadata")
    .eq("id", args.connectionId);
  if (args.userId) connQuery = connQuery.eq("user_id", args.userId);
  const { data: conn } = await connQuery.maybeSingle();
  if (!conn) return { ok: false, reason: "connection_not_found" };

  const metadata = {
    ...((conn.metadata as Record<string, unknown> | null) ?? {}),
    ...(args.instanceName ? { evolution_instance: args.instanceName } : {}),
    evolution_state: "reauth_required",
    pairing_lost_at: now,
    pairing_lost_reason: args.reason ?? "device_removed",
  };

  let updateConn = supabase
    .from("connections")
    .update({
      status: "offline",
      qr_code: null,
      auto_reconnect: false,
      disconnected_manually: false,
      last_sync_at: now,
      metadata,
    })
    .eq("id", args.connectionId);
  if (args.userId) updateConn = updateConn.eq("user_id", args.userId);
  await safeStep("mark connection reauth_required", () => updateConn);

  let migrations = supabase
    .from("group_migrations")
    .update({ status: "paused", last_error: REAUTH_REQUIRED_MESSAGE })
    .eq("connection_id", args.connectionId)
    .in("status", ["running", "pending"]);
  if (args.userId) migrations = migrations.eq("user_id", args.userId);
  await safeStep("pause migrations", () => migrations);

  let broadcasts = supabase
    .from("broadcasts")
    .update({ status: "paused" })
    .eq("connection_id", args.connectionId)
    .eq("status", "running");
  if (args.userId) broadcasts = broadcasts.eq("user_id", args.userId);
  await safeStep("pause broadcasts", () => broadcasts);

  let broadcastIdsQuery = supabase
    .from("broadcasts")
    .select("id")
    .eq("connection_id", args.connectionId)
    .in("status", ["running", "paused"]);
  if (args.userId) broadcastIdsQuery = broadcastIdsQuery.eq("user_id", args.userId);
  const { data: broadcastRows } = await broadcastIdsQuery;
  const broadcastIds = (broadcastRows ?? []).map((row: any) => row.id).filter(Boolean);
  if (broadcastIds.length) {
    await safeStep("requeue sending broadcast targets", () => supabase
      .from("broadcast_targets")
      .update({ status: "pending", error: REAUTH_REQUIRED_MESSAGE })
      .in("broadcast_id", broadcastIds)
      .eq("status", "sending"));
  }

  let scheduled = supabase
    .from("scheduled_messages")
    .update({ last_error: REAUTH_REQUIRED_MESSAGE })
    .eq("connection_id", args.connectionId)
    .in("status", ["pending", "sending"]);
  if (args.userId) scheduled = scheduled.eq("user_id", args.userId);
  await safeStep("mark scheduled", () => scheduled);

  return { ok: true, status: "offline", paused: true };
}