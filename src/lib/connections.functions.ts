import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Nome da instância na Evolution API é derivado do id da linha.
function instanceNameFor(id: string) {
  return `ch_${id.replace(/-/g, "")}`;
}

function webhookUrl(instanceName: string): string | undefined {
  const base = process.env.APP_PUBLIC_URL;
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/api/public/wa/webhook/${instanceName}`;
}

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

    // WhatsApp: cria a instância na Evolution API já com webhook.
    if (data.provider === "whatsapp") {
      try {
        const { evolution } = await import("@/lib/evolution.server");
        const name = instanceNameFor(row.id);
        await evolution.createInstance(name, webhookUrl(name));
        await context.supabase.from("connections")
          .update({ metadata: { evolution_instance: name } })
          .eq("id", row.id);
      } catch (e: any) {
        // não bloqueia — deixa o usuário tentar reconectar depois
        console.error("[connections] createInstance falhou:", e?.message);
      }
    }

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
    // remove instância na Evolution antes (best-effort)
    try {
      const { evolution } = await import("@/lib/evolution.server");
      const name = instanceNameFor(data.id);
      await evolution.logout(name).catch(() => null);
      await evolution.remove(name).catch(() => null);
    } catch { /* ignore */ }

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
    // garante que a instância existe (idempotente) e busca o QR
    const { evolution, evolutionStateToStatus } = await import("@/lib/evolution.server");
    const name = instanceNameFor(data.id);

    // tenta criar (se já existir a Evolution retorna erro — ignoramos)
    await evolution.createInstance(name, webhookUrl(name)).catch(() => null);

    let qrBase64: string | null = null;
    let status: "online" | "offline" | "connecting" = "connecting";
    try {
      const connectRes = await evolution.connect(name);
      qrBase64 = connectRes.base64 ?? null;
    } catch (e: any) {
      // Se falhar em connect, tenta ler estado atual
      try {
        const s = await evolution.state(name);
        status = evolutionStateToStatus(s.instance?.state);
      } catch { /* ignore */ }
    }

    const { data: row, error } = await context.supabase
      .from("connections")
      .update({
        status,
        qr_code: qrBase64,
        last_sync_at: new Date().toISOString(),
        metadata: { evolution_instance: name },
      })
      .eq("id", data.id).eq("user_id", context.userId).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const refreshConnectionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { evolution, evolutionStateToStatus } = await import("@/lib/evolution.server");
    const name = instanceNameFor(data.id);
    let status: "online" | "offline" | "connecting" = "offline";
    try {
      const s = await evolution.state(name);
      status = evolutionStateToStatus(s.instance?.state);
    } catch { /* ignore */ }

    const patch: Record<string, unknown> = { status, last_sync_at: new Date().toISOString() };
    if (status === "online") patch.qr_code = null;

    const { data: row, error } = await context.supabase
      .from("connections").update(patch)
      .eq("id", data.id).eq("user_id", context.userId).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const disconnectConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    try {
      const { evolution } = await import("@/lib/evolution.server");
      await evolution.logout(instanceNameFor(data.id)).catch(() => null);
    } catch { /* ignore */ }
    const { error } = await context.supabase.from("connections")
      .update({ status: "offline", qr_code: null }).eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
