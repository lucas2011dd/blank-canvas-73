import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Nome da instância na Evolution API é derivado do id da linha.
function instanceNameFor(id: string) {
  return `ch_${id.replace(/-/g, "")}`;
}

function webhookUrl(instanceName: string): string | undefined {
  const previewHost = process.env.LOVABLE_PREVIEW_HOST;
  const base = process.env.WHATSAPP_WEBHOOK_PUBLIC_URL
    ?? (previewHost ? `https://${previewHost}` : undefined)
    ?? process.env.APP_PUBLIC_URL;
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/api/public/wa/webhook/${instanceName}`;
}

function digitsOnly(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

function safeToIso(ts: unknown): string {
  const now = new Date().toISOString();
  if (ts == null || ts === "") return now;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? now : ts.toISOString();
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? now : d.toISOString();
  }
  const s = String(ts).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const ms = s.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? now : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? now : d.toISOString();
}




const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFreshWhatsappQr(
  evolution: typeof import("@/lib/evolution.server").evolution,
  extractQrImage: typeof import("@/lib/evolution.server").extractQrImage,
  instanceName: string,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const connected = await evolution.connect(instanceName).catch((e: any) => {
      console.error("[connections] connect falhou:", e?.message);
      return null;
    });
    const qr = await extractQrImage(connected);
    if (qr) return qr;
    await wait(900 + attempt * 700);
  }
  return null;
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

    let qrBase64: string | null = null;
    let status: "online" | "offline" | "connecting" | "error" = "offline";
    let evolutionInstance: string | null = null;

    if (data.provider === "whatsapp") {
      try {
        const { evolution, extractQrImage } = await import("@/lib/evolution.server");
        const name = instanceNameFor(row.id);
        evolutionInstance = name;

        // 1) create — já tenta devolver o QR
        const created = await evolution.createInstance(name, webhookUrl(name)).catch((e: any) => {
          console.error("[connections] createInstance falhou:", e?.message);
          return null;
        });
        qrBase64 = await extractQrImage(created);

        // 2) se não veio, força /connect com pequenas retentativas (Evolution pode atrasar o QR)
        if (!qrBase64) {
          qrBase64 = await getFreshWhatsappQr(evolution, extractQrImage, name);
        }
        if (qrBase64) status = "connecting";
      } catch (e: any) {
        console.error("[connections] evolution setup falhou:", e?.message);
      }

      const patch = {
        qr_code: qrBase64,
        status,
        metadata: evolutionInstance ? { evolution_instance: evolutionInstance } : {},
        last_sync_at: new Date().toISOString(),
      };
      const { data: updated, error: updateError } = await context.supabase.from("connections")
        .update(patch)
        .eq("id", row.id).select("*").single();
      if (updateError) console.error("[connections] update QR falhou:", updateError.message);
      Object.assign(row, updated ?? patch);
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
    const { evolution, extractQrImage, resolveEvolutionStatus } = await import("@/lib/evolution.server");
    const name = instanceNameFor(data.id);

    // tenta criar (se já existir a Evolution retorna erro — ignoramos)
    const created = await evolution.createInstance(name, webhookUrl(name)).catch(() => null);

    let qrBase64: string | null = null;
    let status: "online" | "offline" | "connecting" = "connecting";
    qrBase64 = await extractQrImage(created);
    if (!qrBase64) qrBase64 = await getFreshWhatsappQr(evolution, extractQrImage, name);

    if (!qrBase64) {
      try {
        status = (await resolveEvolutionStatus(name)).status;
      } catch { /* ignore */ }
    }

    // Instâncias antigas/presas às vezes não devolvem QR no /connect.
    // Se não estiver online, recria a instância e pede um QR novo.
    if (!qrBase64 && status !== "online") {
      await evolution.logout(name).catch(() => null);
      await evolution.remove(name).catch(() => null);
      const recreated = await evolution.createInstance(name, webhookUrl(name)).catch(() => null);
      qrBase64 = await extractQrImage(recreated);
      if (!qrBase64) {
        qrBase64 = await getFreshWhatsappQr(evolution, extractQrImage, name);
      }
      status = qrBase64 ? "connecting" : "offline";
    }

    const patch = {
      status,
      qr_code: qrBase64,
      last_sync_at: new Date().toISOString(),
      metadata: { evolution_instance: name },
    };

    const { data: row, error } = await context.supabase
      .from("connections")
      .update(patch)
      .eq("id", data.id).eq("user_id", context.userId).select("*").single();
    if (error) {
      console.error("[connections] reconnect update falhou:", error.message);
      const { data: existing } = await context.supabase
        .from("connections")
        .select("*")
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .single();
      if (!existing) throw new Error(error.message);
      return { ...existing, ...patch };
    }
    return row;
  });

export const refreshConnectionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { resolveEvolutionStatus } = await import("@/lib/evolution.server");
    const name = instanceNameFor(data.id);
    let status: "online" | "offline" | "connecting" = "offline";
    let state: string | undefined;
    try {
      const resolved = await resolveEvolutionStatus(name);
      status = resolved.status;
      state = resolved.state;
    } catch { /* ignore */ }

    const { data: existing } = await context.supabase
      .from("connections")
      .select("metadata")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();

    const patch: Record<string, unknown> = {
      status,
      last_sync_at: new Date().toISOString(),
      metadata: {
        ...((existing?.metadata as Record<string, unknown> | null) ?? {}),
        evolution_instance: name,
        evolution_state: state ?? status,
      },
    };
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

// Sincroniza contatos, conversas e grupos da Evolution para o Supabase.
// Também (re)registra o webhook público — resolve o caso "conectei mas não
// aparece nada".
export const syncWhatsappConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { evolution } = await import("@/lib/evolution.server");
    const name = instanceNameFor(data.id);

    // (Re)registra o webhook — a instância pode ter sido criada antes de
    // APP_PUBLIC_URL estar configurada.
    const wh = webhookUrl(name);
    if (wh) await evolution.setWebhook(name, wh);

    const [contactsRaw, chatsRaw, groupsRaw] = await Promise.all([
      evolution.findContacts(name),
      evolution.findChats(name),
      evolution.fetchAllGroups(name),
    ]);

    // ---------- Contatos ----------
    let contactsUpserted = 0;
    const contactRows: Array<{
      user_id: string; name: string; phone: string;
      external_source: string; external_id: string;
      metadata: Record<string, unknown>;
    }> = [];
    for (const c of contactsRaw ?? []) {
      const jid = String(c.remoteJid ?? c.id ?? c.jid ?? "");
      if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;
      const phone = digitsOnly(jid.split("@")[0]);
      if (!phone) continue;
      contactRows.push({
        user_id: context.userId,
        name: String(c.pushName ?? c.name ?? c.notify ?? phone),
        phone,
        external_source: "whatsapp",
        external_id: jid,
        metadata: { profile_pic: c.profilePicUrl ?? null },
      });
    }
    if (contactRows.length) {
      // Insere só o que ainda não existe (por phone) — mantém edições do usuário.
      const phones = Array.from(new Set(contactRows.map((r) => r.phone)));
      const { data: existing } = await context.supabase
        .from("contacts")
        .select("phone")
        .eq("user_id", context.userId)
        .in("phone", phones);
      const existingSet = new Set((existing ?? []).map((r: any) => r.phone));
      const toInsert = contactRows.filter((r) => !existingSet.has(r.phone));
      if (toInsert.length) {
        const { error } = await context.supabase.from("contacts").insert(toInsert);
        if (!error) contactsUpserted = toInsert.length;
      }
    }

    // ---------- Conversas (chats individuais) ----------
    let conversationsUpserted = 0;
    const convRows: Array<{ user_id: string; connection_id: string; title: string; last_message_at: string }> = [];
    const seenTitles = new Set<string>();
    for (const ch of chatsRaw ?? []) {
      const jid = String(ch.remoteJid ?? ch.id ?? ch.jid ?? "");
      if (!jid || jid.endsWith("@g.us") || jid.endsWith("@lid") || jid.endsWith("@newsletter") || jid === "status@broadcast") continue;
      // Só telefones reais (E.164 curto: 8–15 dígitos). LID e sintéticos ficam de fora.
      if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@c.us") && jid.includes("@")) continue;
      const phone = digitsOnly(jid.split("@")[0]);
      if (!phone || phone.length < 8 || phone.length > 15 || seenTitles.has(phone)) continue;
      seenTitles.add(phone);
      const ts = ch.updatedAt ?? ch.lastMessageTimestamp ?? ch.t ?? ch.messageTimestamp;
      convRows.push({
        user_id: context.userId,
        connection_id: data.id,
        title: phone,
        last_message_at: safeToIso(ts),
      });
    }
    if (convRows.length) {
      const titles = convRows.map((r) => r.title);
      const { data: existingConvs } = await context.supabase
        .from("conversations").select("title")
        .eq("user_id", context.userId).eq("connection_id", data.id)
        .in("title", titles);
      const existingSet = new Set((existingConvs ?? []).map((r: any) => r.title));
      const toInsert = convRows.filter((r) => !existingSet.has(r.title));
      if (toInsert.length) {
        const { error } = await context.supabase.from("conversations").insert(toInsert);
        if (!error) conversationsUpserted = toInsert.length;
      }
    }

    // ---------- Grupos ----------
    let groupsUpserted = 0;
    const groupRows = (groupsRaw ?? [])
      .map((g: any) => {
        const jid = String(g.id ?? g.remoteJid ?? "");
        if (!jid.endsWith("@g.us")) return null;
        return {
          user_id: context.userId,
          connection_id: data.id,
          jid,
          subject: String(g.subject ?? g.name ?? "Grupo"),
          description: g.desc ?? g.description ?? null,
          participants_count: Array.isArray(g.participants) ? g.participants.length : (g.size ?? 0),
          owner: g.owner ?? null,
          picture_url: g.pictureUrl ?? null,
          metadata: {},
        };
      })
      .filter(Boolean) as any[];
    if (groupRows.length) {
      const { error } = await context.supabase
        .from("whatsapp_groups")
        .upsert(groupRows, { onConflict: "connection_id,jid" });
      if (!error) groupsUpserted = groupRows.length;
    }

    await context.supabase.from("connections")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", data.id).eq("user_id", context.userId);

    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "sync", entity: "connection", entity_id: data.id,
      metadata: { contactsUpserted, conversationsUpserted, groupsUpserted },
    });

    return { contactsUpserted, conversationsUpserted, groupsUpserted };
  });

export const listWhatsappGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ connectionId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("whatsapp_groups").select("*")
      .eq("user_id", context.userId)
      .eq("connection_id", data.connectionId)
      .order("subject", { ascending: true });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const toggleGroupMonitored = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), monitored: z.boolean() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: grp, error: gErr } = await context.supabase.from("whatsapp_groups")
      .update({ monitored: data.monitored })
      .eq("id", data.id).eq("user_id", context.userId).select("connection_id,subject").single();
    if (gErr) throw new Error(gErr.message);

    // Cria (ou mantém) a conversa correspondente para aparecer no chat imediatamente.
    if (data.monitored && grp) {
      const title = `Grupo: ${grp.subject}`;
      const { data: existing } = await context.supabase.from("conversations").select("id")
        .eq("user_id", context.userId)
        .eq("connection_id", grp.connection_id)
        .eq("title", title).maybeSingle();
      if (!existing) {
        await context.supabase.from("conversations").insert({
          user_id: context.userId,
          connection_id: grp.connection_id,
          title,
          last_message_at: new Date().toISOString(),
        });
      }
    }
    return { ok: true };
  });

