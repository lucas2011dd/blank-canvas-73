import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("connections").select("*").eq("user_id", context.userId).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  provider: z.enum(["whatsapp", "telegram", "custom"]).default("whatsapp"),
});

export const createConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createSchema.parse(d))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("connections")
      .insert({ user_id: context.userId, ...data, status: "offline" })
      .select("*").single();
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "create", entity: "connection", entity_id: row.id,
      metadata: { name: row.name },
    });
    return row;
  });

export const deleteConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("connections").delete().eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "delete", entity: "connection", entity_id: data.id,
    });
    return { ok: true };
  });

export const reconnectConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    // Stub: aqui integraria com Evolution API / Meta Cloud API para gerar QR real.
    // Por ora simulamos: gera um "QR" placeholder e marca connecting.
    const fakeQr = `otpauth://qr/connecthub/${data.id}?ts=${Date.now()}`;
    const { data: row, error } = await context.supabase
      .from("connections").update({ status: "connecting", qr_code: fakeQr, last_sync_at: new Date().toISOString() })
      .eq("id", data.id).eq("user_id", context.userId).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const disconnectConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("connections")
      .update({ status: "offline", qr_code: null }).eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
