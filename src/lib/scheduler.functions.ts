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

function safeNumberAtLeast(value: unknown, fallback: number, floor: number) {
  const n = Number(value ?? fallback);
  return Math.max(floor, Number.isFinite(n) ? n : fallback);
}

function sendLeaseMs() {
  return safeNumberAtLeast(process.env.WHATSAPP_SEND_LEASE_MS, 600_000, 120_000);
}

async function acquireConnectionSendLock(db: any, connectionId: string): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + sendLeaseMs()).toISOString();
  const { data } = await db.from("connections")
    .update({ processing_until: until })
    .eq("id", connectionId)
    .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
    .select("id")
    .maybeSingle();
  return data ? until : null;
}

async function releaseConnectionSendLock(db: any, connectionId: string, lockUntil: string) {
  await db.from("connections")
    .update({ processing_until: null })
    .eq("id", connectionId)
    .eq("processing_until", lockUntil);
}

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

    const { data: conn } = await context.supabase.from("connections")
      .select("id").eq("id", data.connectionId).eq("user_id", context.userId).eq("provider", "whatsapp").maybeSingle();
    if (!conn) throw new Error("Conexão WhatsApp não encontrada");

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
      .select("id,status,metadata").eq("id", row.connection_id).eq("user_id", context.userId).single();
    if (!conn) throw new Error("Conexão não encontrada");
    const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(conn.id).replace(/-/g, "")}`;

    const { evolution, isPairingLostEvolutionError, isTransientEvolutionError } = await import("@/lib/evolution.server");
    const { markConnectionReauthRequired, REAUTH_REQUIRED_MESSAGE } = await import("@/lib/automation-safety.server");
    if (conn.status !== "online") {
      await context.supabase.from("connections").update({
        status: "connecting",
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...((conn.metadata as Record<string, unknown> | null) ?? {}),
          evolution_instance: instance,
          evolution_state: "scheduled_waiting_for_online",
          auto_reconnect_at: new Date().toISOString(),
        },
      }).eq("id", conn.id).eq("user_id", context.userId);
      throw new Error("WhatsApp não está online; envio mantido na fila sem reiniciar a Evolution");
    }
    const lockUntil = await acquireConnectionSendLock(context.supabase, conn.id);
    if (!lockUntil) throw new Error("Outra automação está usando esta conexão; tente novamente em instantes");
    let claimed: any = null;

    try {
      const { data: claimedRow } = await context.supabase.from("scheduled_messages")
        .update({ status: "sending" })
        .eq("id", row.id)
        .eq("user_id", context.userId)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();
      claimed = claimedRow;
      if (!claimed) throw new Error("Agendamento já está sendo processado");

      const target = claimed.target_kind === "group" ? claimed.target : claimed.target;
      await evolution.sendText(instance, target, claimed.body);
      await context.supabase.from("scheduled_messages").update({
        status: "sent", sent_at: new Date().toISOString(), attempts: (claimed.attempts ?? 0) + 1,
      }).eq("id", claimed.id);
      // Recorrência: cria a próxima
      if (claimed.recurrence === "daily" || claimed.recurrence === "weekly") {
        const step = claimed.recurrence === "daily" ? 1 : 7;
        const nextAt = new Date(new Date(claimed.scheduled_at).getTime() + step * 86400_000).toISOString();
        await context.supabase.from("scheduled_messages").insert({
          user_id: context.userId, connection_id: claimed.connection_id,
          target_kind: claimed.target_kind, target: claimed.target, target_label: claimed.target_label,
          body: claimed.body, scheduled_at: nextAt, recurrence: claimed.recurrence, status: "pending",
        });
      }
      return { ok: true };
    } catch (e: any) {
      if (!claimed) throw e;
      if (isPairingLostEvolutionError(e)) {
        await context.supabase.from("scheduled_messages").update({
          status: "pending",
          last_error: REAUTH_REQUIRED_MESSAGE,
          attempts: (claimed.attempts ?? 0) + 1,
        }).eq("id", claimed.id);
        await markConnectionReauthRequired(context.supabase, {
          connectionId: conn.id,
          userId: context.userId,
          instanceName: instance,
          reason: String(e?.message ?? "device_removed"),
        });
        throw new Error(REAUTH_REQUIRED_MESSAGE);
      }
      if (isTransientEvolutionError(e)) {
        await context.supabase.from("connections").update({
          status: "connecting",
          last_sync_at: new Date().toISOString(),
          metadata: {
            ...((conn.metadata as Record<string, unknown> | null) ?? {}),
            evolution_instance: instance,
            evolution_state: "scheduled_transient_backoff_no_restart",
            auto_reconnect_at: new Date().toISOString(),
          },
        }).eq("id", conn.id).eq("user_id", context.userId);
        await context.supabase.from("scheduled_messages").update({
          status: "pending",
          scheduled_at: new Date(Date.now() + 30_000).toISOString(),
          last_error: "Evolution instável; envio será tentado novamente sem restart automático",
          attempts: (claimed.attempts ?? 0) + 1,
        }).eq("id", claimed.id);
        throw new Error("Evolution instável; envio mantido na fila sem reiniciar a sessão");
      }
      await context.supabase.from("scheduled_messages").update({
        status: "failed", last_error: e?.message ?? "erro", attempts: (claimed.attempts ?? 0) + 1,
      }).eq("id", claimed.id);
      throw e;
    } finally {
      await releaseConnectionSendLock(context.supabase, conn.id, lockUntil);
    }
  });
