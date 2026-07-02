import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const inputSchema = z.object({
  limit: z.number().min(1).max(500).optional(),
  action: z.string().optional(),
});

export const listLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => inputSchema.parse(d ?? {}))
  .handler(async ({ context, data }) => {
    let q = context.supabase.from("audit_logs").select("*").eq("user_id", context.userId).order("created_at", { ascending: false });
    if (data.action) q = q.eq("action", data.action);
    const { data: rows, error } = await q.limit(data.limit ?? 200);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
