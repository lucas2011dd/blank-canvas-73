import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function digits(v: unknown) { return String(v ?? "").replace(/\D/g, ""); }
function renderTemplate(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

export const listBroadcasts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("broadcasts")
      .select("*").eq("user_id", context.userId).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getBroadcast = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: bc, error } = await context.supabase.from("broadcasts")
      .select("*").eq("id", data.id).eq("user_id", context.userId).single();
    if (error) throw new Error(error.message);
    const { data: targets } = await context.supabase.from("broadcast_targets")
      .select("*").eq("broadcast_id", data.id).order("created_at");
    return { broadcast: bc, targets: targets ?? [] };
  });

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  connectionId: z.string().uuid(),
  template: z.string().trim().min(1).max(4000),
  minDelaySeconds: z.number().int().min(3).max(600).default(8),
  maxDelaySeconds: z.number().int().min(3).max(3600).default(45),
  scheduledAt: z.string().datetime().nullable().optional(),
  // Seleção de alvos: contatos por id, telefones avulsos, ou participantes de grupos
  contactIds: z.array(z.string().uuid()).optional().default([]),
  phones: z.array(z.string()).optional().default([]),
  // Filtros geográficos BR (opcionais). Se ambos vazios: sem filtro.
  filterStates: z.array(z.string().length(2)).optional().default([]),
  filterDdds: z.array(z.string()).optional().default([]),
});

export const createBroadcast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createSchema.parse(d))
  .handler(async ({ context, data }) => {
    if (data.maxDelaySeconds < data.minDelaySeconds) throw new Error("Delay máximo deve ser ≥ mínimo");

    // Resolve alvos
    const { phoneMatchesBrFilter } = await import("@/lib/br-ddd");
    const geoFilter = { states: data.filterStates, ddds: data.filterDdds };
    const targets: Array<{ phone: string; name: string | null; contact_id: string | null }> = [];
    const seen = new Set<string>();

    if (data.contactIds.length) {
      const { data: rows } = await context.supabase.from("contacts")
        .select("id,name,phone").eq("user_id", context.userId).in("id", data.contactIds);
      for (const r of rows ?? []) {
        const p = digits(r.phone);
        if (!p || seen.has(p)) continue;
        if (!phoneMatchesBrFilter(p, geoFilter)) continue;
        seen.add(p);
        targets.push({ phone: p, name: r.name ?? null, contact_id: r.id });
      }
    }
    for (const raw of data.phones) {
      const p = digits(raw);
      if (!p || seen.has(p)) continue;
      if (!phoneMatchesBrFilter(p, geoFilter)) continue;
      seen.add(p);
      targets.push({ phone: p, name: null, contact_id: null });
    }
    if (!targets.length) throw new Error("Nenhum destinatário após filtros (DDD/estado)");

    const { data: bc, error } = await context.supabase.from("broadcasts").insert({
      user_id: context.userId,
      connection_id: data.connectionId,
      name: data.name,
      template: data.template,
      min_delay_seconds: data.minDelaySeconds,
      max_delay_seconds: data.maxDelaySeconds,
      status: "draft",
      total_recipients: targets.length,
      scheduled_at: data.scheduledAt ?? null,
    }).select("*").single();
    if (error) throw new Error(error.message);

    const now = new Date().toISOString();
    const rows = targets.map((t) => ({
      broadcast_id: bc.id, user_id: context.userId,
      contact_id: t.contact_id, phone: t.phone, name: t.name,
      status: "pending" as const, next_attempt_at: data.scheduledAt ?? now,
    }));
    // Insere em lotes de 500
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error: e } = await context.supabase.from("broadcast_targets").insert(chunk);
      if (e) throw new Error(e.message);
    }
    return bc;
  });

export const controlBroadcast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    id: z.string().uuid(),
    action: z.enum(["start", "pause", "resume", "cancel", "delete"]),
  }).parse(d))
  .handler(async ({ context, data }) => {
    if (data.action === "delete") {
      const { error } = await context.supabase.from("broadcasts")
        .delete().eq("id", data.id).eq("user_id", context.userId);
      if (error) throw new Error(error.message);
      return { ok: true };
    }
    const patch: Record<string, unknown> = {};
    if (data.action === "start" || data.action === "resume") { patch.status = "running"; patch.started_at = new Date().toISOString(); }
    if (data.action === "pause") patch.status = "paused";
    if (data.action === "cancel") { patch.status = "completed"; patch.finished_at = new Date().toISOString(); }
    const { data: row, error } = await context.supabase.from("broadcasts")
      .update(patch).eq("id", data.id).eq("user_id", context.userId).select("*").single();
    if (error) throw new Error(error.message);

    // Se cancelou, marca pendentes como skipped
    if (data.action === "cancel") {
      await context.supabase.from("broadcast_targets")
        .update({ status: "skipped" }).eq("broadcast_id", data.id).eq("status", "pending");
    }
    return row;
  });

// Processa uma "tick" no lado do próprio usuário (autenticado) — útil pra
// disparo imediato/manual sem depender de cron externo. Envia até N mensagens.
export const runBroadcastTick = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), max: z.number().int().min(1).max(10).default(3) }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: bc } = await context.supabase.from("broadcasts")
      .select("*").eq("id", data.id).eq("user_id", context.userId).single();
    if (!bc) throw new Error("Broadcast não encontrado");
    if (bc.status !== "running") throw new Error("Broadcast não está rodando");

    const { data: conn } = await context.supabase.from("connections")
      .select("id,status,metadata").eq("id", bc.connection_id).eq("user_id", context.userId).single();
    if (!conn) throw new Error("Conexão WhatsApp não encontrada");
    const instance = (conn.metadata as any)?.evolution_instance ?? `ch_${String(conn.id).replace(/-/g, "")}`;

    const { evolution, isPairingLostEvolutionError, isTransientEvolutionError, reconnectEvolutionSession, resolveEvolutionStatus } = await import("@/lib/evolution.server");
    const { markConnectionReauthRequired, REAUTH_REQUIRED_MESSAGE } = await import("@/lib/automation-safety.server");
    const resolved = await resolveEvolutionStatus(instance);
    if (resolved.status !== "online") {
      if (isPairingLostEvolutionError(resolved.state)) {
        await markConnectionReauthRequired(context.supabase, {
          connectionId: conn.id,
          userId: context.userId,
          instanceName: instance,
          reason: resolved.state ?? "device_removed",
        });
        throw new Error(REAUTH_REQUIRED_MESSAGE);
      }
      const recovered = await reconnectEvolutionSession(instance, { attempts: 3, delayMs: 1_000 }).catch(() => null);
      if (isPairingLostEvolutionError(recovered?.state)) {
        await markConnectionReauthRequired(context.supabase, {
          connectionId: conn.id,
          userId: context.userId,
          instanceName: instance,
          reason: recovered?.state ?? "device_removed",
        });
        throw new Error(REAUTH_REQUIRED_MESSAGE);
      }
      await context.supabase.from("connections").update({
        status: recovered?.status ?? resolved.status,
        ...(recovered?.status === "online" ? { qr_code: null } : {}),
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...((conn.metadata as Record<string, unknown> | null) ?? {}),
          evolution_instance: instance,
          evolution_state: recovered?.state ?? resolved.status,
          auto_reconnect_at: new Date().toISOString(),
        },
      }).eq("id", conn.id).eq("user_id", context.userId);
      if (recovered?.status !== "online") throw new Error("Reconectando WhatsApp sem novo QR; disparo mantido na fila");
    }
    const nowIso = new Date().toISOString();
    const { data: due } = await context.supabase.from("broadcast_targets")
      .select("*").eq("broadcast_id", bc.id).eq("status", "pending")
      .lte("next_attempt_at", nowIso).order("next_attempt_at").limit(data.max);

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const t of due ?? []) {
      await context.supabase.from("broadcast_targets").update({ status: "sending" }).eq("id", t.id);
      const body = renderTemplate(bc.template, { nome: t.name ?? "", name: t.name ?? "", telefone: t.phone });
      try {
        await evolution.sendText(instance, t.phone, body);
        await context.supabase.from("broadcast_targets").update({
          status: "sent", sent_at: new Date().toISOString(),
        }).eq("id", t.id);
        results.push({ id: t.id, ok: true });
      } catch (e: any) {
        if (isPairingLostEvolutionError(e)) {
          await context.supabase.from("broadcast_targets").update({
            status: "pending",
            last_error: REAUTH_REQUIRED_MESSAGE,
          } as any).eq("id", t.id);
          await markConnectionReauthRequired(context.supabase, {
            connectionId: conn.id,
            userId: context.userId,
            instanceName: instance,
            reason: String(e?.message ?? "device_removed"),
          });
          throw new Error(REAUTH_REQUIRED_MESSAGE);
        }
        if (isTransientEvolutionError(e)) {
          const recovered = await reconnectEvolutionSession(instance, { attempts: 2, delayMs: 1_000 }).catch(() => null);
          await context.supabase.from("connections").update({
            status: recovered?.status ?? "connecting",
            ...(recovered?.status === "online" ? { qr_code: null } : {}),
            last_sync_at: new Date().toISOString(),
            metadata: {
              ...((conn.metadata as Record<string, unknown> | null) ?? {}),
              evolution_instance: instance,
              evolution_state: recovered?.state ?? "reconnecting",
              auto_reconnect_at: new Date().toISOString(),
            },
          }).eq("id", conn.id).eq("user_id", context.userId);
          await context.supabase.from("broadcast_targets").update({
            status: "pending",
            next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
            last_error: "Reconectando WhatsApp sem novo QR; alvo mantido na fila",
          } as any).eq("id", t.id);
          break;
        }
        await context.supabase.from("broadcast_targets").update({
          status: "failed", last_error: e?.message ?? "erro",
        } as any).eq("id", t.id);
        results.push({ id: t.id, ok: false, error: e?.message });
      }

      // Marca próximo tick com delay aleatório
      const min = bc.min_delay_seconds ?? 8, max = bc.max_delay_seconds ?? 45;
      const delaySec = Math.floor(min + Math.random() * (max - min + 1));
      const nextAt = new Date(Date.now() + delaySec * 1000).toISOString();
      await context.supabase.from("broadcast_targets")
        .update({ next_attempt_at: nextAt })
        .eq("broadcast_id", bc.id).eq("status", "pending")
        .order("next_attempt_at", { ascending: true }).limit(1);
      // pausa curta entre envios do MESMO tick (anti-flood do próprio worker)
      await new Promise((r) => setTimeout(r, 500));
    }

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    if (okCount || failCount) {
      await context.supabase.from("broadcasts").update({
        sent_count: (bc.sent_count ?? 0) + okCount,
        failed_count: (bc.failed_count ?? 0) + failCount,
      }).eq("id", bc.id);
    }

    // Verifica conclusão
    const { count } = await context.supabase.from("broadcast_targets")
      .select("id", { count: "exact", head: true })
      .eq("broadcast_id", bc.id).eq("status", "pending");
    if ((count ?? 0) === 0) {
      await context.supabase.from("broadcasts").update({
        status: "completed", finished_at: new Date().toISOString(),
      }).eq("id", bc.id);
    }

    return { processed: results.length, results };
  });
