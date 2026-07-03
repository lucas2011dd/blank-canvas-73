import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function refreshGoogleAccessToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("Falha ao renovar token Google");
  return await res.json() as { access_token: string; expires_in: number };
}

async function getValidAccessToken(supabase: any, userId: string): Promise<string> {
  const { data: row } = await supabase.from("google_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!row) throw new Error("Google não conectado — vá em Configurações");
  if (row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 30_000) return row.access_token;
  if (!row.refresh_token) throw new Error("Sessão Google expirada — reconecte");
  const fresh = await refreshGoogleAccessToken(row.refresh_token);
  await supabase.from("google_tokens").update({
    access_token: fresh.access_token,
    expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
  }).eq("user_id", userId);
  return fresh.access_token;
}

export const googleConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("google_tokens").select("expires_at,scope").eq("user_id", context.userId).maybeSingle();
    return { connected: !!data, expiresAt: data?.expires_at ?? null };
  });

export const disconnectGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("google_tokens").delete().eq("user_id", context.userId);
    return { ok: true };
  });

// Importa contatos do Google → sistema (só insere os que não existem por phone).
export const importGoogleContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const token = await getValidAccessToken(context.supabase, context.userId);
    let pageToken: string | undefined;
    let imported = 0;
    const digits = (v: string) => v.replace(/\D/g, "");

    do {
      const url = new URL("https://people.googleapis.com/v1/people/me/connections");
      url.searchParams.set("personFields", "names,phoneNumbers,emailAddresses,organizations");
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Google People API: ${res.status}`);
      const json = await res.json() as any;
      pageToken = json.nextPageToken;

      const rows: any[] = [];
      for (const p of json.connections ?? []) {
        const name = p.names?.[0]?.displayName ?? "Sem nome";
        const phone = digits(p.phoneNumbers?.[0]?.value ?? "");
        const email = p.emailAddresses?.[0]?.value ?? null;
        const company = p.organizations?.[0]?.name ?? null;
        if (!phone) continue;
        rows.push({
          user_id: context.userId, name, phone, email, company,
          external_source: "google", external_id: p.resourceName,
        });
      }
      if (rows.length) {
        const phones = rows.map((r) => r.phone);
        const { data: existing } = await context.supabase.from("contacts")
          .select("phone").eq("user_id", context.userId).in("phone", phones);
        const has = new Set((existing ?? []).map((r: any) => r.phone));
        const toInsert = rows.filter((r) => !has.has(r.phone));
        if (toInsert.length) {
          const { error } = await context.supabase.from("contacts").insert(toInsert);
          if (!error) imported += toInsert.length;
        }
      }
    } while (pageToken);

    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "import", entity: "contact", metadata: { source: "google", count: imported },
    });
    return { imported };
  });

// Exporta contatos do sistema → Google (só os que ainda não têm external_source=google).
export const exportContactsToGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()).optional() }).parse(d ?? {}))
  .handler(async ({ context, data }) => {
    const token = await getValidAccessToken(context.supabase, context.userId);
    let q = context.supabase.from("contacts").select("*").eq("user_id", context.userId);
    if (data.ids?.length) q = q.in("id", data.ids);
    else q = q.neq("external_source", "google");
    const { data: rows } = await q.limit(500);
    let exported = 0;

    for (const c of rows ?? []) {
      const body = {
        names: [{ givenName: c.name }],
        phoneNumbers: c.phone ? [{ value: c.phone }] : undefined,
        emailAddresses: c.email ? [{ value: c.email }] : undefined,
        organizations: c.company ? [{ name: c.company }] : undefined,
      };
      const res = await fetch("https://people.googleapis.com/v1/people:createContact", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = await res.json() as any;
        await context.supabase.from("contacts").update({
          external_source: "google", external_id: json.resourceName,
        }).eq("id", c.id);
        exported++;
      }
    }
    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "export", entity: "contact", metadata: { target: "google", count: exported },
    });
    return { exported };
  });
