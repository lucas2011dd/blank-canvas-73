import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function instanceNameFor(id: string) {
  return `ch_${id.replace(/-/g, "")}`;
}

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

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
    const instance = (conn.metadata as any)?.evolution_instance ?? instanceNameFor(conn.id);
    const { evolution } = await import("@/lib/evolution.server");
    const parts = await evolution.groupParticipants(instance, data.sourceGroupJid);
    const rows = parts.map((p: any) => {
      const jid = participantJid(p);
      return { jid, phone: participantPhone(p), admin: isAdminParticipant(p) };
    }).filter((r) => r.phone.length >= 8);
    return { total: rows.length, participants: rows };
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
    batchSize: z.number().int().min(1).max(10).default(1),
    // CORREÇÃO: Defaults de delay aumentados de 15/30s para 25/60s.
    // O WhatsApp detecta padrões de adição em grupo muito rápidos como spam
    // e desconecta a sessão com device_removed. Intervalos mais longos
    // simulam comportamento humano e evitam a desconexão.
    minDelaySeconds: z.number().int().min(1).max(3600).default(25),
    maxDelaySeconds: z.number().int().min(1).max(3600).default(60),
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

    const { evolution } = await import("@/lib/evolution.server");
    const parts = await evolution.groupParticipants(instance, data.sourceGroupJid);
    const exclude = new Set(data.excludePhones.map((p) => digits(p)));
    if (data.skipSelf && ownerPhone) exclude.add(ownerPhone);

    const filtered = parts.filter((p: any) => {
      if (data.skipAdmins && isAdminParticipant(p)) return false;
      return true;
    });

    const { phoneMatchesBrFilter } = await import("@/lib/br-ddd");
    const geoFilter = { states: data.filterStates, ddds: data.filterDdds };
    let allPhones = Array.from(new Set(
      filtered.map((p: any) => participantPhone(p))
        .filter((p) => p.length >= 8 && !exclude.has(p) && phoneMatchesBrFilter(p, geoFilter))
    ));
    if (data.shuffleOrder) {
      for (let i = allPhones.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allPhones[i], allPhones[j]] = [allPhones[j], allPhones[i]];
      }
    }
    if (data.maxParticipants && allPhones.length > data.maxParticipants) {
      allPhones = allPhones.slice(0, data.maxParticipants);
    }
    if (allPhones.length === 0) throw new Error("Nenhum participante válido após filtros (DDD/estado/exclusões)");

    // Subject de origem — melhor UX no histórico
    let sourceSubject: string | null = null;
    try {
      const info = await evolution.findGroupInfo(instance, data.sourceGroupJid);
      sourceSubject = info?.subject ?? info?.data?.subject ?? null;
    } catch { /* noop */ }

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
      // CORREÇÃO (item 4): quando cria um grupo novo, o primeiro batch NÃO
      // deve rodar imediatamente. Adicionar mais membros logo após a criação
      // do grupo é o padrão que mais dispara device_removed no Baileys. Damos
      // um respiro mínimo (default 60s) antes do próximo add.
      next_attempt_at: (data.mode === "new_group" && allPhones.length > initialAdded.length)
        ? new Date(Date.now() + Number(process.env.MIGRATION_NEW_GROUP_INITIAL_DELAY_MS ?? 60_000)).toISOString()
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
      await context.supabase.from("group_migration_targets").insert(targetsRows);
    }

    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "create", entity: "group_migration", entity_id: mig.id,
      metadata: { total: allPhones.length, mode: data.mode },
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
    if (data.action === "resume") { patch.status = "running"; patch.next_attempt_at = new Date().toISOString(); }
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
    return { ...result, batchesProcessed: 1 };
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
      .select("id")
      .eq("user_id", context.userId)
      .eq("status", "running")
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
      .limit(10);
    const results: any[] = [];
    for (const m of due ?? []) {
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
