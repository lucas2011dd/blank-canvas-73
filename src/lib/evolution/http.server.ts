// Transporte HTTP para a Evolution API — responsabilidade única: fazer a chamada.
// Isolado de parsing de QR, normalização de estado e lógica de client.

function env() {
  const base = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  if (!base || !key) throw new Error("EVOLUTION_API_URL/EVOLUTION_API_KEY não configurados");
  return { base: base.replace(/\/$/, ""), key };
}

export function evolutionEnv() {
  return env();
}

export function webhookAuthHeaders(key: string) {
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET ?? key;
  return {
    apikey: secret,
    "x-evolution-webhook-secret": secret,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ConnectHub-Webhook/1.0",
    Accept: "application/json, text/plain, */*",
  };
}

export function webhookConfig(url: string, key: string) {
  const events = [
    "MESSAGES_UPSERT",
    "CONNECTION_UPDATE",
    "QRCODE_UPDATED",
  ];
  return {
    enabled: true,
    url,
    // Filtra na origem para não receber dumps grandes (contacts/chats/presence).
    byEvents: true,
    base64: false,
    webhook_by_events: true,
    webhook_base64: false,
    events,
    headers: webhookAuthHeaders(key),
  };
}

export function stableSettings() {
  return {
    rejectCall: false,
    msgCall: "",
    groupsIgnore: false,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    syncFullHistory: false,
  };
}

const EVOLUTION_WORKING_BASE: Map<string, string> =
  (globalThis as any).__evolutionWorkingBase ??= new Map();

function urlCandidates(base: string, path: string) {
  const primary = `${base}${path}`;
  const candidates: string[] = [];
  const add = (url: string) => {
    if (!candidates.includes(url)) candidates.push(url);
  };
  let primaryIsHttps = false;
  try { primaryIsHttps = new URL(primary).protocol === "https:"; } catch { /* noop */ }

  const cachedBase = EVOLUTION_WORKING_BASE.get(base);
  if (cachedBase) {
    try {
      const cachedProto = new URL(cachedBase).protocol;
      if (!(primaryIsHttps && cachedProto !== "https:")) {
        add(`${cachedBase}${path}`);
      }
    } catch { /* ignora cache inválido */ }
  }
  add(primary);
  try {
    const url = new URL(primary);
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
    if (isIp) {
      const alias = new URL(url.toString());
      alias.hostname = `${url.hostname.replace(/\./g, "-")}.sslip.io`;
      add(alias.toString());
    }
  } catch { /* mantém URL original */ }
  return candidates;
}

export async function evolutionCall<T = any>(
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
  }

  throw lastError ?? new Error("Falha ao chamar Evolution API");
}
