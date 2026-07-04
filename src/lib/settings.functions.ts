import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("profiles").select("*").eq("id", context.userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
    // Auto-cria o profile se ainda não existe
    const { data: created, error: insErr } = await context.supabase
      .from("profiles")
      .insert({ id: context.userId })
      .select("*")
      .maybeSingle();
    if (insErr) throw new Error(insErr.message);
    return created;
  });

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    full_name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().max(64).optional(),
    locale: z.enum(["pt-BR", "en-US", "es"]).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
    avatar_url: z.string().url().optional().nullable(),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase.from("profiles").upsert({ id: context.userId, ...data }).eq("id", context.userId).select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return row;
  });

export const listApiKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("api_keys").select("id,name,last_used_at,created_at,revoked_at")
      .eq("user_id", context.userId).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ name: z.string().trim().min(1).max(120) }).parse(d))
  .handler(async ({ context, data }) => {
    const raw = `ch_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const hash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const { error } = await context.supabase.from("api_keys").insert({ user_id: context.userId, name: data.name, key_hash: hash });
    if (error) throw new Error(error.message);
    return { raw };  // exibir apenas 1x
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("api_keys").update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
