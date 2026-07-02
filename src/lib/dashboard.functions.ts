import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getDashboardStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [conns, msgs, contacts, logs] = await Promise.all([
      supabase.from("connections").select("id,status", { count: "exact" }).eq("user_id", userId),
      supabase.from("messages").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("contacts").select("id", { count: "exact", head: true }).eq("user_id", userId),
      supabase.from("audit_logs").select("id,action,entity,created_at,metadata").eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
    ]);
    const online = conns.data?.filter((c) => c.status === "online").length ?? 0;
    return {
      totalConnections: conns.count ?? 0,
      onlineConnections: online,
      offlineConnections: (conns.count ?? 0) - online,
      totalMessages: msgs.count ?? 0,
      totalContacts: contacts.count ?? 0,
      recentActivity: logs.data ?? [],
    };
  });
