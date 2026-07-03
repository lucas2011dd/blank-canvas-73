// Cliente HTTP mínimo para a Evolution API v2.
// Só é importado dentro de handlers de server functions / server routes.

function env() {
  const base = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  if (!base || !key) throw new Error("EVOLUTION_API_URL/EVOLUTION_API_KEY não configurados");
  return { base: base.replace(/\/$/, ""), key };
}

async function call<T = any>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { base, key } = env();
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: key,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* pass */ }
  if (!res.ok) {
    const msg = json?.response?.message?.[0] ?? json?.message ?? text ?? `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return json as T;
}

export const evolution = {
  async createInstance(
    instanceName: string,
    webhookUrl?: string,
  ): Promise<{ qrcode?: { base64?: string; code?: string; pairingCode?: string | null } }> {
    const body: any = {
      instanceName,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
    };
    if (webhookUrl) {
      body.webhook = {
        url: webhookUrl,
        byEvents: false,
        base64: true,
        events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
      };
    }
    return call("/instance/create", { method: "POST", body });
  },

  async connect(
    instanceName: string,
  ): Promise<{ base64?: string; code?: string; pairingCode?: string | null }> {
    return call(`/instance/connect/${encodeURIComponent(instanceName)}`);
  },

  async state(instanceName: string): Promise<{ instance?: { state?: "open" | "connecting" | "close" } }> {
    return call(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
  },

  async logout(instanceName: string) {
    return call(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
  },

  async remove(instanceName: string) {
    return call(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
  },

  async sendText(instanceName: string, number: string, text: string) {
    return call(`/message/sendText/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: { number, text },
    });
  },
};

export function evolutionStateToStatus(state?: string): "online" | "offline" | "connecting" {
  if (state === "open") return "online";
  if (state === "connecting") return "connecting";
  return "offline";
}
