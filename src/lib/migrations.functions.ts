import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function instanceNameFor(id: string) {
  return `ch_${id.replace(/-/g, "")}`;
}

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function safeNumberAtLeast(value: unknown, fallback: number, floor: number) {
  const n = Number(value ?? fallback);
  return Math.max(floor, Number.isFinite(n) ? n : fallback);
}

function participantPhone(p: any): string {
  return digits(
    p?.phoneNumber ??
    p?.phone_number ??
    p?.number ??
    p?.participantPn ??
    p?.pn ??
    p?.jid ??
    p?.id ??
    "",
  );
}

function participantJid(p: any): string {
  return String(p?.phoneNumber ?? p?.jid ?? p?.id ?? "");
}

// Detecta admin de forma robusta — Evolution v2 varia entre versões:
//  - { admin: "admin" | "superadmin" | null }
//  - { admin: true } (booleano)
//  - { isAdmin: bool, isSuperAdmin: bool }
//  - { role: "admin" | "superadmin" }
function isAdminParticipant(p: any): boolean {
  const a = p?.admin ?? p?.role ?? null;
  if (a === "admin" || a === "superadmin" || a === true) return true;
  if (p?.isAdmin === true || p?.isSuperAdmin === true) return true;
  return false;
}

// Preview de participantes do grupo de origem (sem persistir nada).
export const previewGroupParticipants = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    connectionId: z.string().uuid(),
    sourceGroupJid: z.string().min(3),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: conn } = await context.supabase.from("connections")
      .select("id,status,metadata").eq("id", data.connectionId).eq("user_id", context.userId).maybeSingle();
    if (!conn) throw new Error("Conexão não encontrada");
    if (conn.status !== "online") throw new Error("Conexão precisa estar online");
    const { count: activeOnConnection } = await context.supabase.from("group_migrations")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", data.connectionId)
      .in("status", ["running", "pending"]);
    if ((activeOnConnection ?? 0) > 0) throw new Error("Já existe uma migração em andamento nessa conexão");
    const instance = (conn.metadata as any)?.evolution_instance ?? instanceNameFor(conn.id);
    const { evolution } = await import("@/lib/evolution.server");
    const parts = await evolution.groupParticipants(instance, data.sourceGroupJid);
    let total = 0;
    let adminCount = 0;
    for (const p of parts) {
      if (participantPhone(p).length < 8) continue;
      total++;
      if (isAdminParticipant(p)) adminCount++;
    }
    return { total, adminCount };
  });

export const listGroupMigrations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("group_migrations")
      .select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getGroupMigration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: mig } = await context.supabase.from("group_migrations")
      .select("*").eq("id", data.id).eq("user_id", context.userId).maybeSingle();
    if (!mig) throw new Error("Migração não encontrada");
    const { data: targets } = await context.supabase.from("group_migration_targets")
      .select("*").eq("migration_id", data.id).order("created_at", { ascending: true });
    return { migration: mig, targets: targets ?? [] };
  });

// Cria a migração:
//  - mode 'new_group': cria um novo grupo com o subject informado.
//    O primeiro batch de participantes é usado na criação (Evolution exige
//    pelo menos 1). Os demais entram na fila.
//  - mode 'existing_group': envia participantes para targetGroupJid já existente.
export const startGroupMigration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    connectionId: z.string().uuid(),
    sourceGroupJid: z.string().min(3),
    mode: z.enum(["new_group", "existing_group"]),
    targetGroupJid: z.string().optional(),
    targetSubject: z.string().trim().max(120).optional(),
    targetDescription: z.string().trim().max(500).optional(),
    // HARDENING: máx 1 tanto no cliente quanto no servidor. O worker
    // (automationBatchSize) já força 1 — deixar 10 aqui só engana a UI e
    // reabre o risco de device_removed se alguém remover o clamp do worker.
    batchSize: z.number().int().min(1).max(1).default(1),
    // Defaults conservadores para VPS 2 vCPU/4GB: cada catch pesa na Evolution.
    minDelaySeconds: z.number().int().min(1).max(3600).default(180),
    maxDelaySeconds: z.number().int().min(1).max(3600).default(300),
    excludePhones: z.array(z.string()).default([]),
    skipAdmins: z.boolean().default(true),
    skipSelf: z.boolean().default(true),
    shuffleOrder: z.boolean().default(true),
    maxParticipants: z.number().int().min(1).max(1024).optional(),
    // Filtros geográficos BR (opcionais). Se ambos vazios: sem filtro.
    filterStates: z.array(z.string().length(2)).optional().default([]),
    filterDdds: z.array(z.string()).optional().default([]),
  }).parse(d))
  .handler(async ({ context, data }) => {
    if (data.mode === "new_group" && !data.targetSubject) throw new Error("Informe o nome do novo grupo");
    if (data.mode === "existing_group" && !data.targetGroupJid) throw new Error("Informe o grupo de destino");
    if (data.maxDelaySeconds < data.minDelaySeconds) throw new Error("Delay máximo precisa ser >= mínimo");

    const { data: conn } = await context.supabase.from("connections")
      .select("id,status,metadata").eq("id", data.connectionId).eq("user_id", context.userId).maybeSingle();
    if (!conn) throw new Error("Conexão não encontrada");
    if (conn.status !== "online") throw new Error("Conexão precisa estar online");
    const instance = (conn.metadata as any)?.evolution_instance ?? instanceNameFor(conn.id);
    const ownerPhone = digits((conn.metadata as any)?.owner_phone ?? (conn.metadata as any)?.number ?? "");

    // Cada nova migração começa com contador limpo. Sem isso, quedas antigas
    // deixadas em connections.metadata.session_drop_count faziam a primeira
    // oscilação da migração nova atingir o limite e pausar/desconectar tudo.
    const cleanConnMeta: Record<string, unknown> = { ...((conn.metadata as Record<string, unknown> | null) ?? {}) };
    delete cleanConnMeta.session_drop_count;
    delete cleanConnMeta.last_session_drop_at;
    delete cleanConnMeta.last_session_drop_reason;
    delete cleanConnMeta.pairing_lost_at;
    delete cleanConnMeta.pairing_lost_reason;
    delete cleanConnMeta.device_removed_at;
    delete cleanConnMeta.status_reason;
    delete cleanConnMeta.disconnected_at;
    cleanConnMeta.evolution_instance = instance;
    cleanConnMeta.evolution_state = "migration_start_clean";
    await context.supabase.from("connections").update({
      metadata: cleanConnMeta,
      auto_reconnect: true,
      disconnected_manually: false,
      qr_code: null,
      last_sync_at: new Date().toISOString(),
    }).eq("id", data.connectionId).eq("user_id", context.userId);

    const { evolution } = await import("@/lib/evolution.server");
    // 1 única leitura do grupo de origem: participantes + subject saem da
    // mesma chamada findGroupInfo. Antes fazíamos DUAS leituras seguidas do
    // mesmo grupo (groupParticipants → findGroupInfo internamente + outra
    // findGroupInfo para o subject). Duas leituras do mesmo grupo em menos
    // de 1s é padrão de bot; humano abre o grupo 1 vez.
    const sourceInfo = await evolution.findGroupInfo(instance, data.sourceGroupJid);
    const parts: any[] = Array.isArray(sourceInfo?.participants)
      ? sourceInfo.participants
      : Array.isArray(sourceInfo?.data?.participants)
        ? sourceInfo.data.participants
        : Array.isArray(sourceInfo?.groupMetadata?.participants)
          ? sourceInfo.groupMetadata.participants
          : [];
    const sourceSubject: string | null = sourceInfo?.subject ?? sourceInfo?.data?.subject ?? null;

    const exclude = new Set(data.excludePhones.map((p) => digits(p)));
    if (data.skipSelf && ownerPhone) exclude.add(ownerPhone);

    const filtered = parts.filter((p: any) => {
      if (data.skipAdmins && isAdminParticipant(p)) return false;
      return true;
    });

    const { phoneMatchesBrFilter } = await import("@/lib/br-ddd");
    const geoFilter = { states: data.filterStates, ddds: data.filterDdds };
    const maxTargets = Math.min(
      data.maxParticipants ?? Number(process.env.GROUP_MIGRATION_MAX_TARGETS ?? 1024),
      1024,
    );
    const uniquePhones = new Set<string>();
    for (const participant of filtered) {
      const phone = participantPhone(participant);
      if (phone.length < 8 || exclude.has(phone) || !phoneMatchesBrFilter(phone, geoFilter)) continue;
      uniquePhones.add(phone);
      if (!data.shuffleOrder && uniquePhones.size >= maxTargets) break;
    }
    let allPhones = Array.from(uniquePhones);
    if (data.shuffleOrder) {
      for (let i = allPhones.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allPhones[i], allPhones[j]] = [allPhones[j], allPhones[i]];
      }
    }
    if (allPhones.length > maxTargets) {
      allPhones = allPhones.slice(0, maxTargets);
    }
    if (allPhones.length === 0) throw new Error("Nenhum participante válido após filtros (DDD/estado/exclusões)");

    let targetGroupJid = data.targetGroupJid ?? null;
    let targetSubject = data.targetSubject ?? null;
    const initialAdded: string[] = [];

    if (data.mode === "new_group") {
      // Cria com o primeiro batch — Evolution exige participantes na criação.
      // Criar/adicionar muitos membros no mesmo pacote é o padrão que mais
      // derruba Baileys/WhatsApp. Mesmo que a UI permita configurar lote,
      // a criação usa apenas 1 seed para preservar a sessão.
      const seed = allPhones.slice(0, 1);
      const created = await evolution.createGroup(instance, data.targetSubject!, seed, data.targetDescription);
      targetGroupJid = created?.groupJid ?? created?.id ?? created?.group?.id ?? created?.data?.groupJid ?? created?.data?.id ?? created?.data?.group?.id ?? null;
      targetSubject = data.targetSubject!;
      if (!targetGroupJid) throw new Error("Falha ao criar o grupo de destino");

      // Não consultar participantes logo após criar/adicionar: isso pode
      // derrubar o stream da Evolution. Se a criação retornou grupo, confiamos
      // no retorno da API e marcamos o seed como adicionado.
      initialAdded.push(...seed);
    }

    // Persiste migração
    const { data: mig, error: mErr } = await context.supabase.from("group_migrations").insert({
      user_id: context.userId,
      connection_id: data.connectionId,
      source_group_jid: data.sourceGroupJid,
      source_group_subject: sourceSubject,
      target_group_jid: targetGroupJid,
      target_group_subject: targetSubject,
      mode: data.mode,
      batch_size: data.batchSize,
      min_delay_seconds: data.minDelaySeconds,
      max_delay_seconds: data.maxDelaySeconds,
      total: allPhones.length,
      added_count: initialAdded.length,
      status: allPhones.length === initialAdded.length ? "completed" : "running",
      started_at: new Date().toISOString(),
      finished_at: allPhones.length === initialAdded.length ? new Date().toISOString() : null,
      // CORREÇÃO (item 4, endurecida): o primeiro catch NUNCA roda de imediato.
      // Vale tanto para new_group (respiro após criação) quanto para
      // existing_group (evita rajada logo após o insert). Sempre aplicamos o
      // min_delay configurado (com floor de 60s pelo automationDelaySeconds).
      next_attempt_at: allPhones.length > initialAdded.length
        ? new Date(Date.now() + Math.max(180_000, (Number(data.minDelaySeconds) || 180) * 1000)).toISOString()
        : new Date().toISOString(),
    }).select("*").single();
    if (mErr) throw new Error(mErr.message);

    // Alvos
    const targetsRows = allPhones.map((phone) => ({
      migration_id: mig.id,
      user_id: context.userId,
      phone,
      status: initialAdded.includes(phone) ? "added" : "pending",
      added_at: initialAdded.includes(phone) ? new Date().toISOString() : null,
    }));
    if (targetsRows.length) {
      for (const chunk of chunkArray(targetsRows, 100)) {
        await context.supabase.from("group_migration_targets").insert(chunk);
      }
    }

    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "create", entity: "group_migration", entity_id: mig.id,
      metadata: { total: allPhones.length, mode: data.mode, session_counters_reset: true },
    });

    return mig;
  });

export const controlGroupMigration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    id: z.string().uuid(),
    action: z.enum(["pause", "resume", "cancel"]),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const patch: Record<string, unknown> = {};
    if (data.action === "pause") patch.status = "paused";
    if (data.action === "resume") {
      patch.status = "running";
      // HARDENING: ao retomar, também aplicamos delay mínimo (60s) para não
      // disparar um add imediato após um pause — o pause geralmente vem de
      // instabilidade de sessão, então precisamos de respiro.
      patch.next_attempt_at = new Date(Date.now() + 60_000).toISOString();
      patch.last_error = null;

      const { data: mig } = await context.supabase.from("group_migrations")
        .select("connection_id").eq("id", data.id).eq("user_id", context.userId).maybeSingle();
      if (mig?.connection_id) {
        const { data: conn } = await context.supabase.from("connections")
          .select("metadata").eq("id", mig.connection_id).eq("user_id", context.userId).maybeSingle();
        const cleaned: Record<string, unknown> = { ...((conn?.metadata as Record<string, unknown> | null) ?? {}) };
        delete cleaned.session_drop_count;
        delete cleaned.last_session_drop_at;
        delete cleaned.last_session_drop_reason;
        delete cleaned.pairing_lost_at;
        delete cleaned.pairing_lost_reason;
        delete cleaned.device_removed_at;
        delete cleaned.status_reason;
        await context.supabase.from("connections").update({ metadata: cleaned })
          .eq("id", mig.connection_id).eq("user_id", context.userId);
      }
    }
    if (data.action === "cancel") { patch.status = "canceled"; patch.finished_at = new Date().toISOString(); }
    const { error } = await context.supabase.from("group_migrations")
      .update(patch).eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Processa 1 batch AGORA (útil para preview / execução manual).
// O cron externo `/api/public/wa/tick` faz o mesmo em background.
export const runGroupMigrationNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { processGroupMigrationBatch } = await import("@/lib/migrations.server");

    // Segurança da sessão: um clique/manual executa só 1 add. Fazer vários
    // adds na mesma chamada mantém o Worker prendendo a Evolution e costuma
    // derrubar o stream entre o primeiro e o segundo participante.
    const result = await processGroupMigrationBatch(supabaseAdmin, data.id, context.userId);
    return { ...(typeof result === "object" && result !== null ? result : { result }), batchesProcessed: 1 };
  });

// Auto-tick por usuário: chamado pelo painel de Migração de Grupos enquanto
// o usuário estiver com a página aberta. Processa 1 batch de cada migração
// devida (next_attempt_at <= now) do próprio usuário, respeitando os
// cooldowns internos de processGroupMigrationBatch. Assim a migração avança
// sozinha, sem exigir cron externo nem cliques em "Iniciar/Batch agora".
export const tickMyMigrations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { processGroupMigrationBatch } = await import("@/lib/migrations.server");
    const nowIso = new Date().toISOString();
    const { data: due } = await supabaseAdmin
      .from("group_migrations")
      .select("id,connection_id")
      .eq("user_id", context.userId)
      .eq("status", "running")
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
      .order("next_attempt_at", { ascending: true })
      .limit(1);
    const results: any[] = [];
    const touchedConnections = new Set<string>();
    for (const m of due ?? []) {
      if (m.connection_id && touchedConnections.has(m.connection_id)) {
        results.push({ migrationId: m.id, skipped: true, reason: "same_connection_already_processed_this_tick" });
        continue;
      }
      if (m.connection_id) touchedConnections.add(m.connection_id);
      try {
        results.push(await processGroupMigrationBatch(supabaseAdmin, m.id, context.userId));
      } catch (e: any) {
        results.push({ migrationId: m.id, error: String(e?.message ?? e) });
      }
    }
    return { processed: results.length, results };
  });




function jitter(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
