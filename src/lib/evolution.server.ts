// Cliente HTTP mínimo para a Evolution API v2.
// Só é importado dentro de handlers de server functions / server routes.
import QRCode from "qrcode";

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

function pickString(source: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let current: any = source;
    for (const key of path) current = current?.[key];
    if (typeof current === "string" && current.trim()) return current.trim();
  }
  return null;
}

export async function extractQrImage(source: unknown): Promise<string | null> {
  const base64 = pickString(source, [
    ["base64"],
    ["qrcode", "base64"],
    ["qr", "base64"],
    ["data", "base64"],
    ["data", "qrcode", "base64"],
  ]);
  if (base64) return base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;

  const code = pickString(source, [
    ["code"],
    ["qrcode", "code"],
    ["qr", "code"],
    ["data", "code"],
    ["data", "qrcode", "code"],
  ]);
  if (!code) return null;

  return QRCode.toDataURL(code, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 360,
  });
}

export const evolution = {
  async createInstance(
    instanceName: string,
    webhookUrl?: string,
  ): Promise<any> {
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
  ): Promise<any> {
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
