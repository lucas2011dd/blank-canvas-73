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
    const { data: msg, error } = await context.supabase.from("messages").insert({
      conversation_id: data.conversationId, user_id: context.userId, direction: "outbound", body: data.body, status: "sent",
    }).select("*").single();
    if (error) throw new Error(error.message);
    await context.supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", data.conversationId);
    return msg;
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ title: z.string().trim().min(1).max(200) }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase.from("conversations")
      .insert({ user_id: context.userId, title: data.title }).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });
