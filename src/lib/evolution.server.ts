// Cliente HTTP mínimo para a Evolution API v2.
// Só é importado dentro de handlers de server functions / server routes.
import qrGen from "qrcode-generator";

const QR_IMAGE_KEYS = new Set([
  "base64",
  "qr",
  "qrcode",
  "qrCode",
  "qr_code",
  "image",
  "src",
]);

const QR_TEXT_KEYS = new Set([
  "code",
  "pairingCode",
  "pairing_code",
  "text",
]);

function qrToSvgDataUrl(text: string): string {
  const qr = qrGen(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cell = 8;
  const margin = 16;
  const size = count * cell + margin * 2;
  let rects = "";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        rects += `<rect x="${margin + c * cell}" y="${margin + r * cell}" width="${cell}" height="${cell}"/>`;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  const b64 = typeof btoa === "function" ? btoa(svg) : Buffer.from(svg, "utf-8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

function looksLikeImageBase64(value: string): boolean {
  const compact = value.replace(/\s/g, "");
  return (
    compact.startsWith("iVBORw0KGgo") ||
    compact.startsWith("/9j/") ||
    compact.startsWith("R0lGOD") ||
    compact.startsWith("PHN2Zy") ||
    compact.length > 800
  ) && /^[A-Za-z0-9+/]+=*$/.test(compact);
}

function normalizeQrImage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("data:image/")) return trimmed;
  if (trimmed.startsWith("<svg")) {
    const b64 = typeof btoa === "function"
      ? btoa(trimmed)
      : Buffer.from(trimmed, "utf-8").toString("base64");
    return `data:image/svg+xml;base64,${b64}`;
  }
  if (looksLikeImageBase64(trimmed)) {
    const compact = trimmed.replace(/\s/g, "");
    const mime = compact.startsWith("PHN2Zy") ? "image/svg+xml" : "image/png";
    return `data:${mime};base64,${compact}`;
  }
  return null;
}

function collectQrCandidates(source: unknown) {
  const images: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();

  function walk(value: unknown, keyHint = "") {
    if (value == null) return;
    if (typeof value === "string") {
      const normalized = normalizeQrImage(value);
      if (normalized && (!keyHint || QR_IMAGE_KEYS.has(keyHint))) images.push(normalized);
      else if (QR_TEXT_KEYS.has(keyHint) || /qr|code/i.test(keyHint)) codes.push(value.trim());
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, keyHint));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, key);
    }
  }

  walk(source);
  return { images, codes: codes.filter(Boolean) };
}

function env() {
  const base = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  if (!base || !key) throw new Error("EVOLUTION_API_URL/EVOLUTION_API_KEY não configurados");
  return { base: base.replace(/\/$/, ""), key };
}

function webhookAuthHeaders(key: string) {
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET ?? key;
  return {
    apikey: secret,
    "x-evolution-webhook-secret": secret,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ConnectHub-Webhook/1.0",
    Accept: "application/json, text/plain, */*",
  };
}

function webhookConfig(url: string, key: string) {
  const events = [
    "MESSAGES_UPSERT",
    "CONNECTION_UPDATE",
    "QRCODE_UPDATED",
  ];
  return {
    enabled: true,
    url,
    byEvents: false,
    base64: false,
    webhook_by_events: false,
    webhook_base64: false,
    events,
    headers: webhookAuthHeaders(key),
  };
}

function stableSettings() {
  return {
    rejectCall: false,
    msgCall: "",
    groupsIgnore: false,
    alwaysOnline: true,
    readMessages: false,
    readStatus: false,
    // Full-history do Baileys costuma gerar cargas enormes logo após o QR e
    // aumenta risco de timeout/queda. A sincronização do ConnectHub é feita
    // por endpoints leves (contatos/chats/grupos) depois que a sessão abre.
    syncFullHistory: false,
  };
}

function urlCandidates(base: string, path: string) {
  const primary = `${base}${path}`;
  const candidates: string[] = [];
  const add = (url: string) => {
    if (!candidates.includes(url)) candidates.push(url);
  };
  const cachedBase = EVOLUTION_WORKING_BASE.get(base);
  if (cachedBase) add(`${cachedBase}${path}`);
  add(primary);
  try {
    const url = new URL(primary);
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
    if (isIp) {
      const plainIp = new URL(url.toString());
      plainIp.protocol = "http:";
      add(plainIp.toString());

      const alias = new URL(url.toString());
      alias.protocol = "http:";
      alias.hostname = `${url.hostname.replace(/\./g, "-")}.sslip.io`;
      add(alias.toString());
    }
  } catch { /* mantém URL original */ }
  return candidates;
}

const EVOLUTION_WORKING_BASE: Map<string, string> = (globalThis as any).__evolutionWorkingBase ??= new Map();

async function call<T = any>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const { base, key } = env();
  let lastError: Error | null = null;
  const timeoutMs = init.timeoutMs ?? 10_000;

  for (const url of urlCandidates(base, path)) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          apikey: key,
          "Content-Type": "application/json",
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      lastError = new Error(e?.name === "TimeoutError" || e?.name === "AbortError"
        ? `Timeout Evolution API (${timeoutMs}ms) em ${path}`
        : String(e?.message ?? e));
      continue;
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* pass */ }
    if (res.ok) {
      try { EVOLUTION_WORKING_BASE.set(base, new URL(url).origin); } catch { /* noop */ }
      return json as T;
    }

    const rawMsg = json?.response?.message ?? json?.message ?? text ?? `HTTP ${res.status}`;
    const msg = Array.isArray(rawMsg) ? rawMsg.map(String).join(" — ") : rawMsg;
    lastError = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    (lastError as any).status = res.status;
    (lastError as any).statusCode = res.status;
    (lastError as any).body = json ?? text;
    if (!/error code:\s*1003/i.test(lastError.message)) {
      throw lastError;
    }
  }

  throw lastError ?? new Error("Falha ao chamar Evolution API");
}

function pickString(source: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let current: any = source;
    for (const key of path) current = current?.[key];
    if (typeof current === "string" && current.trim()) return current.trim();
  }
  return null;
}

export async function extractQrImage(source: unknown): Promise<string | null> {
  const collected = collectQrCandidates(source);
  if (collected.images[0]) return collected.images[0];

  const base64 = pickString(source, [
    ["base64"],
    ["qrcode", "base64"],
    ["qr", "base64"],
    ["data", "base64"],
    ["data", "qrcode", "base64"],
  ]);
  if (base64) {
    const normalized = normalizeQrImage(base64);
    if (normalized) return normalized;
  }

  const collectedCode = collected.codes[0];
  if (collectedCode) return qrToSvgDataUrl(collectedCode);

  const code = pickString(source, [
    ["code"],
    ["qrcode", "code"],
    ["qr", "code"],
    ["data", "code"],
    ["data", "qrcode", "code"],
  ]);
  if (!code) return null;

  return qrToSvgDataUrl(code);
}

export const evolution = {
  async createInstance(
    instanceName: string,
    webhookUrl?: string,
  ): Promise<any> {
    const { key } = env();
    const body: any = {
      instanceName,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
      ...stableSettings(),
    };
    if (webhookUrl) {
      body.webhook = webhookConfig(webhookUrl, key);
    }
    return call("/instance/create", { method: "POST", body });
  },

  async connect(
    instanceName: string,
  ): Promise<any> {
    return call(`/instance/connect/${encodeURIComponent(instanceName)}`);
  },

  async restart(instanceName: string): Promise<any> {
    const path = `/instance/restart/${encodeURIComponent(instanceName)}`;
    let lastError: unknown = null;
    for (const method of ["POST", "PUT", "GET"] as const) {
      try {
        return await call(path, { method, timeoutMs: 20_000 });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Falha ao reiniciar sessão WhatsApp");
  },

  async state(instanceName: string): Promise<any> {
    return call(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
  },

  async canReadSession(instanceName: string): Promise<boolean> {
    try {
      const res = await call<any>(`/chat/findChats/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: {},
      });
      const rows = Array.isArray(res) ? res : (res?.chats ?? res?.data ?? []);
      return Array.isArray(rows) && rows.length > 0;
    } catch {
      return false;
    }
  },

  async fetchInstances(): Promise<any[]> {
    const res = await call<any>("/instance/fetchInstances").catch(() => []);
    return Array.isArray(res) ? res : (res?.instances ?? res?.data ?? []);
  },

  async fetchInstancesStrict(): Promise<any[]> {
    const res = await call<any>("/instance/fetchInstances");
    return Array.isArray(res) ? res : (res?.instances ?? res?.data ?? []);
  },

  async instanceInfo(instanceName: string): Promise<any | null> {
    const list = await this.fetchInstances();
    return list.find((row: any) => {
      const name = row?.name ?? row?.instanceName ?? row?.instance?.instanceName ?? row?.instance?.name;
      return name === instanceName;
    }) ?? null;
  },

  async instanceInfoStrict(instanceName: string): Promise<any | null> {
    const list = await this.fetchInstancesStrict();
    return list.find((row: any) => {
      const name = row?.name ?? row?.instanceName ?? row?.instance?.instanceName ?? row?.instance?.name;
      return name === instanceName;
    }) ?? null;
  },

  async logout(instanceName: string) {
    const path = `/instance/logout/${encodeURIComponent(instanceName)}`;
    let lastError: unknown = null;
    for (const method of ["DELETE", "POST", "GET"] as const) {
      try {
        return await call(path, { method, timeoutMs: 5_000 });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Falha ao desconectar instância");
  },

  async remove(instanceName: string) {
    const encoded = encodeURIComponent(instanceName);
    const attempts: Array<{ path: string; method: "DELETE" | "POST" | "GET" }> = [
      { path: `/instance/delete/${encoded}`, method: "DELETE" },
      { path: `/instance/delete/${encoded}`, method: "POST" },
      { path: `/instance/delete/${encoded}`, method: "GET" },
      { path: `/instance/remove/${encoded}`, method: "DELETE" },
      { path: `/instance/logout/${encoded}`, method: "DELETE" },
    ];
    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        return await call(attempt.path, { method: attempt.method, timeoutMs: 5_000 });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Falha ao apagar instância");
  },

  async sendText(instanceName: string, number: string, text: string) {
    // Exponential backoff em 5xx/515 (recomendação da spec 2026).
    // Tenta em 2s, 4s, 8s. Erros 4xx (número inválido, sessão morta) NÃO
    // são retentados aqui — vão para o handler do broadcast/scheduler.
    const delays = [0, 2_000, 4_000, 8_000];
    let lastErr: any;
    for (const wait of delays) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        return await call(`/message/sendText/${encodeURIComponent(instanceName)}`, {
          method: "POST",
          body: { number, text },
        });
      } catch (e: any) {
        lastErr = e;
        const status = Number(e?.status ?? e?.statusCode ?? 0);
        const msg = String(e?.message ?? "");
        const retriable = status >= 500 || status === 515 || /timeout|ECONNABORTED|ECONNRESET/i.test(msg);
        if (!retriable) throw e;
      }
    }
    throw lastErr;
  },

  async setWebhook(instanceName: string, url: string) {
    const { key } = env();
    const config = webhookConfig(url, key);
    try {
      return await call(`/webhook/set/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: { webhook: config },
      });
    } catch {
      return call(`/webhook/set/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: config,
      }).catch(() => null);
    }
  },

  async setSettings(instanceName: string) {
    return call(`/settings/set/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: stableSettings(),
    }).catch(() => null);
  },

  async hardenInstance(instanceName: string, webhookUrl?: string | null) {
    const [settings, webhook] = await Promise.all([
      this.setSettings(instanceName),
      webhookUrl ? this.setWebhook(instanceName, webhookUrl) : Promise.resolve(null),
    ]);
    return { settings, webhook };
  },

  async findContacts(instanceName: string): Promise<any[]> {
    const res = await call<any>(`/chat/findContacts/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: { where: {} },
    }).catch(() => []);
    return Array.isArray(res) ? res : (res?.contacts ?? res?.data ?? []);
  },

  async findChats(instanceName: string): Promise<any[]> {
    const res = await call<any>(`/chat/findChats/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: {},
    }).catch(() => []);
    return Array.isArray(res) ? res : (res?.chats ?? res?.data ?? []);
  },

  async fetchAllGroups(instanceName: string): Promise<any[]> {
    const res = await call<any>(
      `/group/fetchAllGroups/${encodeURIComponent(instanceName)}?getParticipants=false`,
      { method: "GET" },
    ).catch(() => []);
    return Array.isArray(res) ? res : (res?.groups ?? res?.data ?? []);
  },

  async findGroupInfo(instanceName: string, groupJid: string): Promise<any> {
    return call<any>(
      `/group/findGroupInfos/${encodeURIComponent(instanceName)}?groupJid=${encodeURIComponent(groupJid)}`,
      { method: "GET" },
    ).catch(() => null);
  },

  async groupParticipants(instanceName: string, groupJid: string): Promise<Array<{ id: string; jid?: string; admin?: string }>> {
    const info = await this.findGroupInfo(instanceName, groupJid);
    const raw = info?.participants ?? info?.data?.participants ?? info?.groupMetadata?.participants ?? [];
    return Array.isArray(raw) ? raw : [];
  },

  async createGroup(instanceName: string, subject: string, participants: string[], description?: string): Promise<any> {
    return call<any>(`/group/create/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: { subject, description, participants },
    });
  },

  async addGroupParticipants(instanceName: string, groupJid: string, participants: string[]): Promise<any> {
    return call<any>(
      `/group/updateParticipant/${encodeURIComponent(instanceName)}?groupJid=${encodeURIComponent(groupJid)}`,
      { method: "POST", body: { action: "add", participants } },
    );
  },
};

export type EvolutionConnectionStatus = "online" | "offline" | "connecting";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function extractEvolutionConnectionState(source: unknown): string | undefined {
  const s: any = source;
  return firstString(
    s?.instance?.state,
    s?.instance?.status,
    s?.instance?.connectionStatus,
    s?.data?.instance?.state,
    s?.data?.instance?.status,
    s?.data?.state,
    s?.data?.status,
    s?.state,
    s?.status,
    s?.connection,
    s?.connectionStatus,
  );
}

export function evolutionStateToStatus(state?: string): EvolutionConnectionStatus {
  const normalized = String(state ?? "").trim().toLowerCase();
  if (!normalized) return "offline";
  if (["open", "online", "connected", "authenticated", "ready"].includes(normalized)) return "online";
  if (
    [
      "offline",
      "disconnected",
      "logout",
      "logged_out",
      "device_removed",
      "not_connected",
      "not connected",
      "not-connect",
      "notconnect",
      "unpaired",
      "unauthorized",
    ].includes(normalized) ||
    normalized.includes("not_connected") ||
    normalized.includes("not connected") ||
    normalized.includes("unauthoriz") ||
    normalized.includes("forbidden") ||
    normalized.includes("401") ||
    normalized.includes("fail") ||
    normalized.includes("logged") ||
    normalized.includes("removed") ||
    normalized.includes("disconnect")
  ) return "offline";
  if (["close", "closed", "stream:error", "stream error"].includes(normalized) || normalized.includes("close")) return "connecting";
  if (
    ["connecting", "qr", "qrcode", "pairing"].includes(normalized) ||
    normalized.includes("connect") ||
    normalized.includes("qr") ||
    normalized.includes("pair")
  ) return "connecting";
  return "offline";
}

export function payloadIndicatesPairingLost(source: unknown): boolean {
  // IMPORTANTE: só considera "pareamento perdido" quando o próprio CAMPO de
  // estado indica isso. Não pode varrer o payload inteiro porque o
  // fetchInstances da Evolution v2 devolve a lista de eventos do webhook
  // (que contém "LOGOUT_INSTANCE") e configs como "alwaysOnline" — isso
  // gerava falso positivo e forçava offline mesmo com WhatsApp "open".
  const s: any = source ?? {};
  const stateField = firstString(
    s?.instance?.state,
    s?.instance?.status,
    s?.instance?.connectionStatus,
    s?.data?.instance?.state,
    s?.data?.instance?.status,
    s?.data?.state,
    s?.data?.status,
    s?.state,
    s?.status,
    s?.connection,
    s?.connectionStatus,
  );
  const normalized = String(stateField ?? "").toLowerCase();
  if (
    normalized === "device_removed" ||
    normalized === "logged_out" ||
    normalized === "logged out" ||
    normalized === "logout" ||
    normalized === "unpaired" ||
    normalized === "unauthorized" ||
    normalized.includes("device_removed") ||
    normalized.includes("logged_out") ||
    normalized.includes("logged out") ||
    normalized.includes("unpaired")
  ) return true;

  const reason = firstString(
    s?.statusReason,
    s?.instance?.statusReason,
    s?.disconnectReason,
    s?.instance?.disconnectReason,
  );
  if (reason && (reason === "401" || reason.includes("401"))) return true;

  return false;
}

export function isPairingLostEvolutionState(state: unknown): boolean {
  const normalized = String(state ?? "").trim().toLowerCase();
  return (
    normalized === "device_removed" ||
    normalized === "logged_out" ||
    normalized === "logged out" ||
    normalized === "logout" ||
    normalized === "unpaired" ||
    normalized === "unauthorized" ||
    normalized.includes("device_removed") ||
    normalized.includes("logged_out") ||
    normalized.includes("logged out") ||
    normalized.includes("unpaired") ||
    normalized.includes("conflict") && normalized.includes("401") ||
    normalized.includes("stream:error") && normalized.includes("401")
  );
}

export function isPairingLostEvolutionError(error: unknown): boolean {
  const haystack = typeof error === "object" && error !== null
    ? JSON.stringify(error, Object.getOwnPropertyNames(error)).toLowerCase()
    : String(error ?? "").toLowerCase();
  return (
    isPairingLostEvolutionState(haystack) ||
    haystack.includes("instance is not connected") ||
    haystack.includes("the instance is not connected") ||
    haystack.includes("não está conectada") ||
    haystack.includes("nao esta conectada") ||
    haystack.includes("statuscode\":401") ||
    haystack.includes("status code\":401") ||
    haystack.includes("status\":401")
  );
}

export function isTransientEvolutionError(error: unknown): boolean {
  if (isPairingLostEvolutionError(error)) return false;
  const haystack = typeof error === "object" && error !== null
    ? JSON.stringify(error, Object.getOwnPropertyNames(error)).toLowerCase()
    : String(error ?? "").toLowerCase();
  return (
    haystack.includes("connection closed") ||
    haystack.includes("connection close") ||
    haystack.includes("instance is not connected") ||
    haystack.includes("the instance is not connected") ||
    haystack.includes("not_connected") ||
    haystack.includes("not connected") ||
    haystack.includes("timed out") ||
    haystack.includes("timeout") ||
    haystack.includes("socket") ||
    haystack.includes("network") ||
    haystack.includes("fetch failed") ||
    haystack.includes("evolution temporariamente") ||
    haystack.includes("temporarily unavailable") ||
    haystack.includes("device_removed") ||
    haystack.includes("logged_out") ||
    haystack.includes("logged out") ||
    haystack.includes("stream:error") && haystack.includes("401") ||
    haystack.includes("statusreason\":401") ||
    haystack.includes("statusreason:401")
  );
}

export async function resolveEvolutionStatus(instanceName: string): Promise<{
  status: EvolutionConnectionStatus;
  state?: string;
  usable: boolean;
}> {
  let state: string | undefined;
  let stateError: unknown = null;
  let statusFromState: EvolutionConnectionStatus = "offline";
  try {
    const rawState = await evolution.state(instanceName);
    state = extractEvolutionConnectionState(rawState);
    if (payloadIndicatesPairingLost(rawState)) {
      return { status: "offline", state: state ?? "device_removed", usable: false };
    }
    statusFromState = evolutionStateToStatus(state);
    if (statusFromState === "online") return { status: "online", state, usable: true };
  } catch (error) {
    stateError = error;
    // Cai para fetchInstances apenas para descobrir estado/QR. Se também não
    // conseguirmos falar com a Evolution, a chamada deve falhar em vez de
    // marcar offline por engano e induzir reescaneamento de QR.
  }

  let infoLookupFailed = false;
  const info = await evolution.instanceInfoStrict(instanceName).catch(() => {
    infoLookupFailed = true;
    return undefined;
  });
  if (infoLookupFailed && stateError) throw stateError;
  if (info === undefined) return { status: statusFromState, state: state ?? statusFromState, usable: false };
  const infoState = extractEvolutionConnectionState(info);
  if (payloadIndicatesPairingLost(info)) {
    return { status: "offline", state: infoState ?? state ?? "device_removed", usable: false };
  }
  const infoStatus = evolutionStateToStatus(infoState);
  if (infoStatus === "online") return { status: "online", state: infoState, usable: true };
  if (infoStatus === "connecting") return { status: "connecting", state: infoState, usable: false };
  if (statusFromState === "connecting") return { status: "connecting", state, usable: false };
  return { status: "offline", state: state ?? infoState ?? "not_connected", usable: false };
}

export async function reconnectEvolutionSession(
  instanceName: string,
  options: { attempts?: number; delayMs?: number; allowConnect?: boolean } = {},
): Promise<{ status: EvolutionConnectionStatus; state?: string; usable: boolean; restarted: boolean }> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 1_500;
  const allowConnect = options.allowConnect ?? false;

  const before = await resolveEvolutionStatus(instanceName).catch(() => null);
  if (before?.status === "online") return { ...before, restarted: false };
  if (before && isPairingLostEvolutionState(before.state)) return { ...before, restarted: false };

  // Reconexão automática preserva sessão: usa restart/reload. /connect só é
  // permitido em ação manual, pois em Baileys pode iniciar fluxo de QR.
  // /instance/restart retorna 400 quando a sessão não está conectada.
  // Isso é esperado após queda total — ignoramos e deixamos o chamador decidir
  // se aciona /connect para gerar novo QR.
  await evolution.restart(instanceName).catch(() => undefined);

  let latest = before ?? { status: "connecting" as EvolutionConnectionStatus, state: "restart_requested", usable: false };
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait(delayMs + attempt * 500);
    latest = await resolveEvolutionStatus(instanceName).catch(() => latest);
    if (latest.status === "online") return { ...latest, restarted: true };
    if (allowConnect && attempt === 0) {
      await evolution.connect(instanceName).catch(() => undefined);
    }
  }

  return { ...latest, restarted: true };
}
