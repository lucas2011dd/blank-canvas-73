import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().max(255).optional().nullable().or(z.literal("")),
  company: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

const listInput = z.object({ search: z.string().optional() });
export const listContacts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => listInput.parse(d ?? {}))
  .handler(async ({ context, data }) => {
    let q = context.supabase.from("contacts").select("*").eq("user_id", context.userId).order("name");
    const safeSearch = data.search?.replace(/[,().]/g, " ").trim();
    if (safeSearch) q = q.or(`name.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%,company.ilike.%${safeSearch}%`);
    const { data: rows, error } = await q.limit(500);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const createContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => contactSchema.parse(d))
  .handler(async ({ context, data }) => {
    const payload = { ...data, email: data.email || null, user_id: context.userId, external_source: "manual" };
    const { data: row, error } = await context.supabase.from("contacts").insert(payload).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("contacts").delete().eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const importContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    items: z.array(contactSchema).max(5000),
    source: z.enum(["csv", "xlsx", "vcf", "google"]).default("csv"),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const rows = data.items.map((i) => ({ ...i, email: i.email || null, user_id: context.userId, external_source: data.source }));
    const { data: inserted, error } = await context.supabase.from("contacts").insert(rows).select("id");
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "import", entity: "contact",
      metadata: { count: inserted?.length ?? 0, source: data.source },
    });
    return { count: inserted?.length ?? 0 };
  });
