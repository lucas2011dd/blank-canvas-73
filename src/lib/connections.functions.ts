import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildWebhookUrl } from "@/lib/webhook-url";

// Nome da instância na Evolution API é derivado do id da linha.
function instanceNameFor(id: string) {
  return `ch_${id.replace(/-/g, "")}`;
}

function instanceNameFromConnection(row: { id: string; metadata?: unknown }) {
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  return typeof meta.evolution_instance === "string" && meta.evolution_instance.trim()
    ? meta.evolution_instance.trim()
    : instanceNameFor(row.id);
}

function instanceNameFromEvolutionRow(raw: any): string | null {
  return raw?.name ?? raw?.instanceName ?? raw?.instance?.instanceName ?? raw?.instance?.name ?? null;
}

function isIgnorableCleanupError(error: any): boolean {
  const msg = String(error?.message ?? error ?? "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find");
}

async function safeDbStep(label: string, action: () => Promise<{ error?: any } | any>) {
  const result = await action().catch((error: any) => ({ error }));
  if (result?.error && !isIgnorableCleanupError(result.error)) {
    console.error(`[connections] cleanup ${label} falhou:`, result.error.message ?? result.error);
  }
  return result;
}

async function hardDeleteConnectionRows(db: any, userId: string, connectionIds: string[]) {
  const ids = Array.from(new Set(connectionIds.filter(Boolean)));
  if (!ids.length) return 0;

  const { data: conversations } = await safeDbStep("select conversations", () => db
    .from("conversations").select("id").eq("user_id", userId).in("connection_id", ids));
  const conversationIds = ((conversations ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (conversationIds.length) {
    await safeDbStep("messages", () => db.from("messages").delete().in("conversation_id", conversationIds));
  }
  await safeDbStep("conversations", () => db.from("conversations").delete().eq("user_id", userId).in("connection_id", ids));

  const { data: broadcasts } = await safeDbStep("select broadcasts", () => db
    .from("broadcasts").select("id").eq("user_id", userId).in("connection_id", ids));
  const broadcastIds = ((broadcasts ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (broadcastIds.length) {
    await safeDbStep("broadcast targets", () => db.from("broadcast_targets").delete().in("broadcast_id", broadcastIds));
  }
  await safeDbStep("broadcasts", () => db.from("broadcasts").delete().eq("user_id", userId).in("connection_id", ids));

  const { data: migrations } = await safeDbStep("select migrations", () => db
    .from("group_migrations").select("id").eq("user_id", userId).in("connection_id", ids));
  const migrationIds = ((migrations ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (migrationIds.length) {
    await safeDbStep("migration targets", () => db.from("group_migration_targets").delete().in("migration_id", migrationIds));
  }
  await safeDbStep("group migrations", () => db.from("group_migrations").delete().eq("user_id", userId).in("connection_id", ids));

  await safeDbStep("scheduled messages", () => db.from("scheduled_messages").delete().eq("user_id", userId).in("connection_id", ids));
  await safeDbStep("whatsapp groups", () => db.from("whatsapp_groups").delete().eq("user_id", userId).in("connection_id", ids));
  await safeDbStep("connection sessions", () => db.from("connection_sessions").delete().eq("user_id", userId).in("connection_id", ids));
  await safeDbStep("audit logs", () => db.from("audit_logs").delete().eq("user_id", userId).eq("entity", "connection").in("entity_id", ids));

  const { error, count } = await db
    .from("connections")
    .delete({ count: "exact" })
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw new Error(`Falha ao limpar conexão no ConnectHub: ${error.message}`);
  return count ?? ids.length;
}

async function removeEvolutionBestEffort(evolution: typeof import("@/lib/evolution.server").evolution, instanceName: string) {
  const withTimeout = <T,>(p: Promise<T>, ms = 5_000) =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
  await withTimeout(evolution.logout(instanceName)).catch(() => null);
  await withTimeout(evolution.remove(instanceName)).catch(() => null);
  const list = await withTimeout(evolution.fetchInstancesStrict(), 5_000).catch(() => null);
  if (!Array.isArray(list)) return false;
  return !list.some((raw: any) => instanceNameFromEvolutionRow(raw) === instanceName);
}

async function cleanupDb(preferred: any) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return supabaseAdmin;
  } catch {
    return preferred;
  }
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

function stateNeedsQr(state: unknown): boolean {
  const s = String(state ?? "").trim().toLowerCase();
  return (
    s.includes("qr") ||
    s.includes("pair") ||
    s.includes("not_connected") ||
    s.includes("not connected") ||
    s.includes("unpaired") ||
    s.includes("logged") ||
    s.includes("logout") ||
    s.includes("removed") ||
    s.includes("401")
  );
}

function stateIndicatesSessionRemoved(state: unknown): boolean {
  const s = String(state ?? "").trim().toLowerCase();
  return (
    s.includes("device_removed") ||
    s.includes("logged out") ||
    s.includes("logged_out") ||
    s.includes("logout") ||
    s.includes("removed") ||
    s.includes("unpaired") ||
    s.includes("401")
  );
}

async function getFreshWhatsappQr(
  evolution: typeof import("@/lib/evolution.server").evolution,
  extractQrImage: typeof import("@/lib/evolution.server").extractQrImage,
  instanceName: string,
) {
  // Uma única chamada a /connect. O QR chega em seguida pelo webhook
  // QRCODE_UPDATED e é escrito em connections.qr_code — o navegador do
  // usuário reage via realtime. Isso evita floodar o console da VPS com
  // várias regenerações de QR (Evolution loga cada QR gerado).
  const connected = await evolution.connect(instanceName).catch((e: any) => {
    console.error("[connections] connect falhou:", e?.message);
    return null;
  });
  return await extractQrImage(connected);
}


// Puxa o QR direto da Evolution (instanceInfo + connect) e persiste em
// connections.qr_code. O cliente chama isto em polling curto enquanto o
// usuário está aguardando o QR — não depende da fila de webhook drenar.
export const pollWhatsappQr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { evolution, extractQrImage, resolveEvolutionStatus } = await import("@/lib/evolution.server");
    const { data: existing } = await context.supabase
      .from("connections").select("id,status,qr_code,metadata")
      .eq("id", data.id).eq("user_id", context.userId).maybeSingle();
    if (!existing) throw new Error("Conexão não encontrada");
    if (existing.status === "online") return { status: "online" as const, qr: null };
    if (existing.qr_code) return { status: existing.status, qr: existing.qr_code };

    const meta = (existing.metadata as Record<string, unknown> | null) ?? {};
    const name = typeof meta.evolution_instance === "string"
      ? meta.evolution_instance
      : instanceNameFor(data.id);

    // 1) Tenta extrair de instanceInfo (não gera novo QR na Evolution).
    let qr: string | null = null;
    const info = await evolution.instanceInfo(name).catch(() => null);
    qr = await extractQrImage(info);

    // 2) Se nada, uma única chamada a /connect (Evolution só regenera se precisar).
    if (!qr) {
      const connected = await evolution.connect(name).catch(() => null);
      qr = await extractQrImage(connected);
    }

    // 3) Ainda nada — reporta status atual sem forçar mais nada.
    if (!qr) {
      const resolved = await resolveEvolutionStatus(name).catch(() => null);
      const status = resolved?.status ?? existing.status;
      return { status, qr: null };
    }

    await context.supabase.from("connections").update({
      qr_code: qr, status: "connecting",
      last_sync_at: new Date().toISOString(),
      metadata: { ...meta, evolution_instance: name, evolution_state: "qr_required" },
    }).eq("id", data.id).eq("user_id", context.userId);

    return { status: "connecting" as const, qr };
  });

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
        const created = await evolution.createInstance(name, buildWebhookUrl(name)).catch((e: any) => {
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
  .inputValidator((d: unknown) => z.object({
    id: z.string().uuid(),
    keepEvolution: z.boolean().optional(),
  }).parse(d))
  .handler(async ({ context, data }) => {
    // 1) Descobre o nome REAL da instância na Evolution (pode ter sido adotada).
    const { data: existing } = await context.supabase
      .from("connections").select("id,metadata,provider")
      .eq("id", data.id).eq("user_id", context.userId).maybeSingle();
    if (!existing) throw new Error("Conexão não encontrada");

    const name = instanceNameFromConnection(existing);

    // 1) Apaga PRIMEIRO e manualmente no ConnectHub. Não dependemos de FK
    //    cascade nem da Evolution responder; isso remove instância congelada
    //    da tela mesmo quando o Manager não consegue apagar.
    const db = await cleanupDb(context.supabase);
    const connecthubRemoved = await hardDeleteConnectionRows(db, context.userId, [data.id]);

    // 2) Best-effort: derruba na Evolution em segundo plano com timeout curto.
    let removedFromEvolution: boolean | null = data.keepEvolution ? null : true;
    if (!data.keepEvolution && existing.provider === "whatsapp") {
      try {
        const { evolution } = await import("@/lib/evolution.server");
        removedFromEvolution = await removeEvolutionBestEffort(evolution, name);
      } catch { /* ignore */ }
    }

    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "delete", entity: "connection", entity_id: data.id,
      metadata: { evolution_instance: name, removedFromEvolution, connecthubRemoved },
    });
    return { ok: true, removedFromEvolution, connecthubRemoved, evolutionInstance: name };
  });

// ------------------------------------------------------------------
// Adoção de instâncias já existentes na Evolution + limpezas em massa.
// ------------------------------------------------------------------

// Lista todas as instâncias vivas na Evolution API e marca quais já estão
// vinculadas a alguma conexão do usuário (para não aparecerem duplicadas).
export const listEvolutionInstances = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { evolution, extractEvolutionConnectionState, evolutionStateToStatus } = await import("@/lib/evolution.server");
    const [rawList, { data: linkedRows }] = await Promise.all([
      evolution.fetchInstances().catch(() => []),
      context.supabase.from("connections").select("id,name,metadata,user_id").eq("user_id", context.userId),
    ]);

    const linkedMap = new Map<string, { id: string; label: string }>();
    for (const row of linkedRows ?? []) {
      const inst = instanceNameFromConnection(row);
      linkedMap.set(inst, { id: row.id, label: row.name });
    }

    return (rawList ?? []).map((raw: any) => {
      const instanceName = instanceNameFromEvolutionRow(raw) ?? "";
      const state = extractEvolutionConnectionState(raw);
      const status = evolutionStateToStatus(state);
      const ownerJid = raw?.ownerJid ?? raw?.owner ?? raw?.instance?.owner ?? raw?.instance?.ownerJid ?? null;
      const profileName = raw?.profileName ?? raw?.instance?.profileName ?? null;
      const profilePic = raw?.profilePicUrl ?? raw?.instance?.profilePicUrl ?? null;
      const linked = linkedMap.get(instanceName);
      return {
        instanceName,
        status,
        state: state ?? null,
        ownerJid,
        profileName,
        profilePic,
        linked: linked ? { id: linked.id, label: linked.label } : null,
      };
    }).filter((r) => r.instanceName);
  });

// Adota uma instância existente na Evolution, criando um vínculo no ConnectHub
// com o rótulo escolhido (ex.: "WhatsApp 1"). NÃO cria uma nova instância.
export const attachEvolutionInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    instanceName: z.string().trim().min(1),
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const { evolution, extractQrImage, resolveEvolutionStatus } = await import("@/lib/evolution.server");

    // Já vinculado a outra conexão? Bloqueia para evitar duplicata.
    const { data: dupes } = await context.supabase
      .from("connections").select("id,name,metadata")
      .eq("user_id", context.userId);
    for (const row of dupes ?? []) {
      const meta = (row.metadata as Record<string, unknown> | null) ?? {};
      if (meta.evolution_instance === data.instanceName) {
        throw new Error(`Esta instância já está vinculada como "${row.name}".`);
      }
    }

    const info = await evolution.instanceInfo(data.instanceName).catch(() => null);
    if (!info) throw new Error("Instância não encontrada na Evolution API");

    const resolved = await resolveEvolutionStatus(data.instanceName).catch(() => null);
    const status = resolved?.status ?? "offline";

    // (Re)aponta webhook para nosso endpoint público — Evolution pode ter sido
    // criada manualmente sem webhook configurado.
    const wh = buildWebhookUrl(data.instanceName);
    if (wh) await evolution.setWebhook(data.instanceName, wh).catch(() => null);

    let qrBase64: string | null = null;
    if (status !== "online") {
      const connected = await evolution.connect(data.instanceName).catch(() => null);
      qrBase64 = await extractQrImage(connected);
    }

    const { data: row, error } = await context.supabase.from("connections").insert({
      user_id: context.userId,
      name: data.label,
      description: data.description ?? "",
      provider: "whatsapp",
      status: status === "online" ? "online" : (qrBase64 ? "connecting" : status),
      qr_code: qrBase64,
      last_sync_at: new Date().toISOString(),
      metadata: { evolution_instance: data.instanceName, adopted: true },
    }).select("*").single();
    if (error) throw new Error(error.message);

    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "attach", entity: "connection", entity_id: row.id,
      metadata: { evolution_instance: data.instanceName },
    });
    return row;
  });

// Remove UMA instância na Evolution (usada pelo menu "Limpar" na tela de
// instâncias existentes). Se `alsoRemoveConnection` for true, também apaga
// o vínculo no ConnectHub.
export const removeEvolutionInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    instanceName: z.string().trim().min(1),
    alsoRemoveConnection: z.boolean().optional(),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const { evolution } = await import("@/lib/evolution.server");
    const removedFromEvolution = await removeEvolutionBestEffort(evolution, data.instanceName);

    let connecthubRemoved = 0;
    if (data.alsoRemoveConnection) {
      const { data: rows } = await context.supabase
        .from("connections").select("id,metadata").eq("user_id", context.userId);
      const ids = (rows ?? [])
        .filter((r) => instanceNameFromConnection(r) === data.instanceName)
        .map((r) => r.id);
      if (ids.length) {
        const db = await cleanupDb(context.supabase);
        connecthubRemoved = await hardDeleteConnectionRows(db, context.userId, ids);
      }
    }
    return { ok: true, removedFromEvolution, connecthubRemoved };
  });

// Limpeza em massa. `scope` decide o que fazer:
//  - "evolution"       → apaga TODAS as instâncias na Evolution (mantém ConnectHub)
//  - "connecthub"      → apaga TODAS as conexões do usuário no ConnectHub (mantém Evolution)
//  - "both"            → apaga tudo dos dois lados
export const wipeConnections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    scope: z.enum(["evolution", "connecthub", "both"]),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const { evolution } = await import("@/lib/evolution.server");
    const withTimeout = <T,>(p: Promise<T>, ms = 4000) =>
      Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);

    const { data: localRows } = await context.supabase
      .from("connections").select("id,metadata,provider").eq("user_id", context.userId);

    // 1) ConnectHub primeiro — nunca fica travado por causa da Evolution.
    let connecthubRemoved = 0;
    if (data.scope === "connecthub" || data.scope === "both") {
      const ids = (localRows ?? []).map((r) => r.id);
      if (ids.length) {
        const db = await cleanupDb(context.supabase);
        connecthubRemoved = await hardDeleteConnectionRows(db, context.userId, ids);
      }
    }

    // 2) Evolution best-effort, cada instância com timeout curto.
    let evolutionRemoved = 0;
    if (data.scope === "evolution" || data.scope === "both") {
      const listed = await withTimeout(evolution.fetchInstances(), 6000).catch(() => [] as any[]);
      const localNames = (localRows ?? [])
        .filter((r) => r.provider === "whatsapp")
        .map((r) => instanceNameFromConnection(r));
      const listedNames = (listed ?? [])
        .map((raw: any) => instanceNameFromEvolutionRow(raw))
        .filter((name: string | null): name is string => Boolean(name));
      const names = new Set<string>([
        ...localNames,
        ...listedNames,
      ]);
      for (const name of names) {
        const ok = await removeEvolutionBestEffort(evolution, name);
        if (ok) evolutionRemoved++;
      }
    }

    await context.supabase.from("audit_logs").insert({
      user_id: context.userId, action: "wipe", entity: "connection", entity_id: null,
      metadata: { scope: data.scope, evolutionRemoved, connecthubRemoved },
    });
    return { evolutionRemoved, connecthubRemoved };
  });

export const reconnectConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    // Reconexão NÃO destrutiva: nunca apaga/recria uma sessão existente aqui.
    // Apagar a instância força o WhatsApp a pedir QR de novo e foi a causa de
    // sessões ainda válidas caírem apenas dentro do ConnectHub.
    const { evolution, extractQrImage, reconnectEvolutionSession, resolveEvolutionStatus } = await import("@/lib/evolution.server");
    const { data: existing } = await context.supabase
      .from("connections")
      .select("metadata,status")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!existing) throw new Error("Conexão não encontrada");

    const existingMeta = (existing.metadata as Record<string, unknown> | null) ?? {};
    const name = typeof existingMeta.evolution_instance === "string"
      ? existingMeta.evolution_instance
      : instanceNameFor(data.id);

    let qrBase64: string | null = null;
    let status: "online" | "offline" | "connecting" = existing.status as "online" | "offline" | "connecting";
    let state: string | undefined;
    let suppressManualQr = false;

    const wh = buildWebhookUrl(name);
    if (wh) await evolution.setWebhook(name, wh).catch(() => null);

    const [{ count: activeBroadcasts }, { count: activeMigrations }] = await Promise.all([
      context.supabase.from("broadcasts")
        .select("id", { count: "exact", head: true })
        .eq("connection_id", data.id)
        .eq("status", "running"),
      context.supabase.from("group_migrations")
        .select("id", { count: "exact", head: true })
        .eq("connection_id", data.id)
        .eq("status", "running"),
    ]);
    const hasActiveAutomation = Boolean((activeBroadcasts ?? 0) + (activeMigrations ?? 0));

    try {
      const resolved = await resolveEvolutionStatus(name);
      status = resolved.status;
      state = resolved.state;
    } catch {
      throw new Error("Servidor WhatsApp indisponível no momento; mantive a sessão atual sem gerar novo QR.");
    }

    if (status !== "online") {
      const recovered = await reconnectEvolutionSession(name, {
        attempts: 3,
        delayMs: 1_000,
        allowConnect: !hasActiveAutomation,
      }).catch(() => null);
      if (recovered?.status === "online") {
        status = "online";
        qrBase64 = null;
        state = recovered.state;
      } else {
        status = recovered?.status ?? status;
        state = recovered?.state ?? state;
      }
    }

    if (status !== "online") {
      if (hasActiveAutomation) {
        status = "connecting";
        qrBase64 = null;
        suppressManualQr = true;
        state = state ?? "silent_reconnect_during_automation";
      }
    }

    if (status !== "online" && !suppressManualQr) {
      const connected = await evolution.connect(name).catch(() => null);
      qrBase64 = await extractQrImage(connected);
      if (!qrBase64) qrBase64 = await getFreshWhatsappQr(evolution, extractQrImage, name);
      if (qrBase64) {
        const resolvedAfterQr = await resolveEvolutionStatus(name).catch(() => null);
        if (resolvedAfterQr?.status === "online") {
          status = "online";
          qrBase64 = null;
          state = resolvedAfterQr.state;
        } else {
          status = "connecting";
          state = resolvedAfterQr?.state ?? "qr_required_manual";
        }
      }
      if (!qrBase64) {
        status = "connecting";
        state = state ?? "silent_reconnect_no_qr_returned";
      }
    }

    // Clique manual em "Reconectar" reativa o auto-reconnect e limpa o flag
    // de desconexão manual — o usuário quer que a instância volte a rodar.
    const { clearManualDisconnect, persistSessionSnapshot } = await import("@/lib/session-store.server");
    await clearManualDisconnect(context.supabase, data.id);

    const patch: Record<string, unknown> = {
      status,
      qr_code: qrBase64,
      last_sync_at: new Date().toISOString(),
      disconnected_manually: false,
      auto_reconnect: true,
      metadata: {
        ...existingMeta,
        evolution_instance: name,
        evolution_state: state ?? status,
      },
    };
    if (status === "online") patch.last_seen_online_at = new Date().toISOString();

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

    await persistSessionSnapshot(context.supabase, data.id, {
      instanceName: name,
      status,
      state,
    }).catch(() => null);

    return row;
  });

export const refreshConnectionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { resolveEvolutionStatus } = await import("@/lib/evolution.server");
    const { data: existing } = await context.supabase
      .from("connections")
      .select("metadata,status")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!existing) throw new Error("Conexão não encontrada");

    const existingMeta = (existing.metadata as Record<string, unknown> | null) ?? {};
    const name = typeof existingMeta.evolution_instance === "string"
      ? existingMeta.evolution_instance
      : instanceNameFor(data.id);
    let status: "online" | "offline" | "connecting" = existing.status as "online" | "offline" | "connecting";
    let state: string | undefined;
    if (status === "online") {
      const [{ count: activeBroadcasts }, { count: activeMigrations }] = await Promise.all([
        context.supabase.from("broadcasts")
          .select("id", { count: "exact", head: true })
          .eq("connection_id", data.id)
          .eq("status", "running"),
        context.supabase.from("group_migrations")
          .select("id", { count: "exact", head: true })
          .eq("connection_id", data.id)
          .eq("status", "running"),
      ]);
      if (Boolean((activeBroadcasts ?? 0) + (activeMigrations ?? 0))) {
        return { id: data.id, status, metadata: existingMeta, unchanged: true, automationActive: true };
      }
    }
    try {
      const resolved = await resolveEvolutionStatus(name);
      status = resolved.status;
      state = resolved.state;
    } catch {
      return { id: data.id, status, metadata: existingMeta, unchanged: true };
    }

    const patch: Record<string, unknown> = {
      status,
      last_sync_at: new Date().toISOString(),
      metadata: {
        ...existingMeta,
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
    // Marca como desconexão manual — a partir daqui os loops automáticos NÃO
    // devem tentar reconectar essa instância até o usuário clicar em Conectar.
    const { markManualDisconnect } = await import("@/lib/session-store.server");
    await markManualDisconnect(context.supabase, data.id);
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
    const wh = buildWebhookUrl(name);
    if (wh) await evolution.setWebhook(name, wh);

    const [contactsRes, chatsRes, groupsRes] = await Promise.allSettled([
      evolution.findContacts(name),
      evolution.findChats(name),
      evolution.fetchAllGroups(name),
    ]);
    const contactsRaw = contactsRes.status === "fulfilled" ? contactsRes.value : [];
    const chatsRaw = chatsRes.status === "fulfilled" ? chatsRes.value : [];
    const groupsRaw = groupsRes.status === "fulfilled" ? groupsRes.value : [];

    // Detecta socket morto (device_removed / Connection Closed) — sync silencioso não resolve
    const failures = [contactsRes, chatsRes, groupsRes].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    const socketDead = failures.some((f) => /Connection Closed|device_removed|401/i.test(String(f.reason?.message ?? f.reason ?? "")));
    if (socketDead && contactsRaw.length === 0 && chatsRaw.length === 0 && groupsRaw.length === 0) {
      // Tenta um restart; se falhar, sinaliza para o usuário reparear.
      try { await evolution.restart(name); } catch { /* noop */ }
      throw new Error("A sessão do WhatsApp foi removida dos aparelhos conectados no seu celular. Clique em Reconectar e escaneie o QR novamente.");
    }

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

