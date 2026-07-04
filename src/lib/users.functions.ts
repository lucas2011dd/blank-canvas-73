import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function ensureAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error || !data) throw new Response("Forbidden", { status: 403 });
}

export const listUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: authList, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw new Error(error.message);
    const ids = authList.users.map((u) => u.id);
    const [{ data: profiles }, { data: roles }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id,email,full_name,is_active,created_at").in("id", ids),
      supabaseAdmin.from("user_roles").select("user_id,role").in("user_id", ids),
    ]);
    const pmap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
    const rmap = new Map<string, string[]>();
    for (const r of roles ?? []) {
      const arr = rmap.get((r as any).user_id) ?? [];
      arr.push((r as any).role);
      rmap.set((r as any).user_id, arr);
    }
    return authList.users.map((u) => ({
      id: u.id,
      email: u.email ?? "",
      full_name: (pmap.get(u.id) as any)?.full_name ?? "",
      is_active: (pmap.get(u.id) as any)?.is_active ?? true,
      roles: rmap.get(u.id) ?? [],
      last_sign_in_at: u.last_sign_in_at,
      created_at: u.created_at,
    }));
  });

export const createUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        email: z.string().email().max(255),
        password: z.string().min(8).max(72),
        full_name: z.string().min(2).max(120),
        role: z.enum(["admin", "user"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.full_name },
    });
    if (error) throw new Error(error.message);
    // trigger cria profile+role 'user'; ajusta role se admin
    if (data.role === "admin" && created.user) {
      await supabaseAdmin.from("user_roles").insert({ user_id: created.user.id, role: "admin" });
    }
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId,
      action: "user.created",
      entity: "auth.users",
      entity_id: created.user?.id,
      metadata: { email: data.email, role: data.role },
    });
    return { id: created.user?.id };
  });

export const setUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ user_id: z.string().uuid(), is_active: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context);
    if (data.user_id === context.userId) throw new Error("Não pode desativar a si mesmo");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ is_active: data.is_active })
      .eq("id", data.user_id);
    if (error) throw new Error(error.message);
    // ban_duration bloqueia login imediatamente quando desativado
    await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      ban_duration: data.is_active ? "none" : "876000h",
    });
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId,
      action: data.is_active ? "user.activated" : "user.deactivated",
      entity: "auth.users",
      entity_id: data.user_id,
    });
    return { ok: true };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ user_id: z.string().uuid(), role: z.enum(["admin", "user"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context);
    if (data.user_id === context.userId && data.role !== "admin")
      throw new Error("Não pode remover seu próprio admin");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
    await supabaseAdmin.from("user_roles").insert({ user_id: data.user_id, role: data.role });
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId,
      action: "user.role_changed",
      entity: "auth.users",
      entity_id: data.user_id,
      metadata: { role: data.role },
    });
    return { ok: true };
  });

export const resetUserPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ user_id: z.string().uuid(), password: z.string().min(8).max(72) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId,
      action: "user.password_reset",
      entity: "auth.users",
      entity_id: data.user_id,
    });
    return { ok: true };
  });

export const deleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context);
    if (data.user_id === context.userId) throw new Error("Não pode excluir a si mesmo");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId,
      action: "user.deleted",
      entity: "auth.users",
      entity_id: data.user_id,
    });
    return { ok: true };
  });

export const getMyRole = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const roles = (data ?? []).map((r: any) => r.role);
    return { roles, isAdmin: roles.includes("admin") };
  });
