import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const createSchema = z.object({
  connectionId: z.string().uuid(),
  targetKind: z.enum(["phone", "group"]),
  target: z.string().trim().min(1).max(200),          // dígitos ou jid @g.us
  targetLabel: z.string().trim().max(200).optional().nullable(),
  body: z.string().trim().min(1).max(4000),
  scheduledAt: z.string().datetime(),
  recurrence: z.enum(["none", "daily", "weekly"]).default("none"),
});

export const listScheduled = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("scheduled_messages")
      .select("*").eq("user_id", context.userId).order("scheduled_at", { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createScheduled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createSchema.parse(d))
  .handler(async ({ context, data }) => {
    const target = data.targetKind === "phone" ? data.target.replace(/\D/g, "") : data.target;
    if (!target) throw new Error("Destino inválido");
    if (data.targetKind === "group" && !target.endsWith("@g.us")) throw new Error("JID de grupo deve terminar em @g.us");

    const { data: row, error } = await context.supabase.from("scheduled_messages").insert({
      user_id: context.userId,
      connection_id: data.connectionId,
      target_kind: data.targetKind,
      target,
      target_label: data.targetLabel ?? null,
      body: data.body,
      scheduled_at: data.scheduledAt,
      recurrence: data.recurrence,
      status: "pending",
    }).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });

export const cancelScheduled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("scheduled_messages")
      .update({ status: "canceled" }).eq("id", data.id).eq("user_id", context.userId).eq("status", "pending");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteScheduled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("scheduled_messages")
      .delete().eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Envia manualmente uma mensagem agendada agora (bypass do tick).
export const runScheduledNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: row } = await context.supabase.from("scheduled_messages")
      .select("*").eq("id", data.id).eq("user_id", context.userId).single();
    if (!row) throw new Error("Não encontrado");
    if (row.status !== "pending") throw new Error("Já processada");

    const { data: conn } = await context.supabase.from("connections")
      .select("id,status,metadata").eq("id", row.connection_id).single();
    if (!conn || conn.status !== "online") throw new Error("Conexão offline");
    const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(conn.id).replace(/-/g, "")}`;

    const { evolution } = await import("@/lib/evolution.server");
    const target = row.target_kind === "group" ? row.target : row.target;
    try {
      await evolution.sendText(instance, target, row.body);
      await context.supabase.from("scheduled_messages").update({
        status: "sent", sent_at: new Date().toISOString(), attempts: (row.attempts ?? 0) + 1,
      }).eq("id", row.id);
      // Recorrência: cria a próxima
      if (row.recurrence === "daily" || row.recurrence === "weekly") {
        const step = row.recurrence === "daily" ? 1 : 7;
        const nextAt = new Date(new Date(row.scheduled_at).getTime() + step * 86400_000).toISOString();
        await context.supabase.from("scheduled_messages").insert({
          user_id: context.userId, connection_id: row.connection_id,
          target_kind: row.target_kind, target: row.target, target_label: row.target_label,
          body: row.body, scheduled_at: nextAt, recurrence: row.recurrence, status: "pending",
        });
      }
      return { ok: true };
    } catch (e: any) {
      await context.supabase.from("scheduled_messages").update({
        status: "failed", last_error: e?.message ?? "erro", attempts: (row.attempts ?? 0) + 1,
      }).eq("id", row.id);
      throw e;
    }
  });
