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

function urlCandidates(base: string, path: string) {
  const primary = `${base}${path}`;
  try {
    const url = new URL(primary);
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
    if (url.protocol === "https:" && isIp) {
      url.protocol = "http:";
      return [url.toString(), primary];
    }
  } catch { /* mantém URL original */ }
  return [primary];
}

async function call<T = any>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { base, key } = env();
  let lastError: Error | null = null;

  for (const url of urlCandidates(base, path)) {
    const res = await fetch(url, {
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
    if (res.ok) return json as T;

    const msg = json?.response?.message?.[0] ?? json?.message ?? text ?? `HTTP ${res.status}`;
    lastError = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
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
