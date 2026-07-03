import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("conversations").select("*").eq("user_id", context.userId).order("last_message_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ conversationId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("messages").select("*").eq("conversation_id", data.conversationId).order("created_at");
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    conversationId: z.string().uuid(),
    body: z.string().trim().min(1).max(4000),
  }).parse(d))
  .handler(async ({ context, data }) => {
    // Descobre se a conversa está atrelada a uma conexão WhatsApp
    const { data: conv } = await context.supabase
      .from("conversations")
      .select("id,title,connection_id")
      .eq("id", data.conversationId).eq("user_id", context.userId).maybeSingle();
    if (!conv) throw new Error("Conversa não encontrada");

    let status: "sent" | "failed" = "sent";
    if (conv.connection_id) {
      const { data: conn } = await context.supabase
        .from("connections").select("id,provider,status,metadata")
        .eq("id", conv.connection_id).maybeSingle();
      if (conn?.provider === "whatsapp" && conn.status === "online") {
        try {
          const { evolution } = await import("@/lib/evolution.server");
          const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(conn.id).replace(/-/g, "")}`;
          const phone = String(conv.title ?? "").replace(/\D/g, "");
          if (!phone) throw new Error("Título da conversa deve ser o número (somente dígitos)");
          await evolution.sendText(instance, phone, data.body);
        } catch (e: any) {
          status = "failed";
          console.error("[sendMessage] evolution:", e?.message);
        }
      }
    }

    const { data: msg, error } = await context.supabase.from("messages").insert({
      conversation_id: data.conversationId, user_id: context.userId, direction: "outbound", body: data.body, status,
    }).select("*").single();
    if (error) throw new Error(error.message);
    await context.supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", data.conversationId);
    if (status === "failed") throw new Error("Falha ao enviar via WhatsApp — verifique a conexão");
    return msg;
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    title: z.string().trim().min(1).max(200),
    connectionId: z.string().uuid().optional().nullable(),
    phone: z.string().trim().max(30).optional().nullable(),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const phone = data.phone ? data.phone.replace(/\D/g, "") : null;
    const title = phone || data.title;

    if (data.connectionId && phone) {
      const { data: existing } = await context.supabase
        .from("conversations").select("*")
        .eq("user_id", context.userId)
        .eq("connection_id", data.connectionId)
        .eq("title", phone).maybeSingle();
      if (existing) return existing;
    }

    const { data: row, error } = await context.supabase.from("conversations")
      .insert({
        user_id: context.userId,
        title,
        connection_id: data.connectionId ?? null,
      }).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    await context.supabase.from("messages").delete().eq("conversation_id", data.id).eq("user_id", context.userId);
    const { error } = await context.supabase.from("conversations").delete()
      .eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
