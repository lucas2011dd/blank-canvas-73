// Cliente Evolution API v2 — camada de orquestração.
// Transporte, parsing de QR e normalização de estado vivem em src/lib/evolution/*.
// Este arquivo é o barrel: preserva 100% da API pública original
// (evolution, extractQrImage, extractEvolutionConnectionState, ...).
import {
  evolutionCall as call,
  evolutionEnv as env,
  stableSettings,
  webhookConfig,
} from "./evolution/http.server";
import {
  extractEvolutionConnectionState,
  evolutionStateToStatus,
  isPairingLostEvolutionState,
  payloadIndicatesPairingLost,
  type EvolutionConnectionStatus,
} from "./evolution/state.server";

// Re-exports públicos (compatibilidade total com imports existentes).
export { extractQrImage } from "./evolution/qr.server";
export {
  extractEvolutionConnectionState,
  extractEvolutionErrorCode,
  evolutionStateToStatus,
  isPairingLostEvolutionError,
  isPairingLostEvolutionState,
  isTransientEvolutionError,
  payloadIndicatesPairingLost,
  type EvolutionConnectionStatus,
} from "./evolution/state.server";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Extrai o nome canônico de uma linha de /instance/fetchInstances. */
function instanceRowName(row: any): string | undefined {
  return row?.name ?? row?.instanceName ?? row?.instance?.instanceName ?? row?.instance?.name;
}

/** Tenta múltiplos verbos HTTP para endpoints "destrutivos" (restart/logout/remove). */
async function tryMethods<T>(
  path: string,
  methods: ReadonlyArray<"POST" | "PUT" | "GET" | "DELETE">,
  timeoutMs = 5_000,
  errMsg = "Falha na chamada",
): Promise<T> {
  let lastError: unknown = null;
  for (const method of methods) {
    try {
      return await call<T>(path, { method, timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errMsg);
}

export const evolution = {
  async createInstance(instanceName: string, webhookUrl?: string): Promise<any> {
    const { key } = env();
    const body: any = {
      instanceName,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
      ...stableSettings(),
    };
    if (webhookUrl) body.webhook = webhookConfig(webhookUrl, key);
    return call("/instance/create", { method: "POST", body });
  },

  async connect(instanceName: string): Promise<any> {
    return call(`/instance/connect/${encodeURIComponent(instanceName)}`);
  },

  async restart(instanceName: string): Promise<any> {
    return tryMethods(
      `/instance/restart/${encodeURIComponent(instanceName)}`,
      ["POST", "PUT", "GET"],
      5_000,
      "Falha ao reiniciar sessão WhatsApp",
    );
  },

  async state(instanceName: string): Promise<any> {
    return call(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
  },

  async canReadSession(instanceName: string): Promise<boolean> {
    try {
      const rawState = await this.state(instanceName);
      const state = extractEvolutionConnectionState(rawState);
      return evolutionStateToStatus(state) === "online" && !payloadIndicatesPairingLost(rawState);
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
    return list.find((row: any) => instanceRowName(row) === instanceName) ?? null;
  },

  async instanceInfoStrict(instanceName: string): Promise<any | null> {
    const list = await this.fetchInstancesStrict();
    return list.find((row: any) => instanceRowName(row) === instanceName) ?? null;
  },

  async logout(instanceName: string) {
    return tryMethods(
      `/instance/logout/${encodeURIComponent(instanceName)}`,
      ["DELETE", "POST"],
      5_000,
      "Falha ao desconectar instância",
    );
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
    // Exponential backoff em 5xx/515. 4xx (número inválido, sessão morta)
    // não é retentado aqui — sobe para o handler de broadcast/scheduler.
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
    });
    return Array.isArray(res) ? res : (res?.contacts ?? res?.data ?? []);
  },

  async findChats(instanceName: string): Promise<any[]> {
    const res = await call<any>(`/chat/findChats/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: {},
    });
    return Array.isArray(res) ? res : (res?.chats ?? res?.data ?? []);
  },

  async fetchAllGroups(instanceName: string): Promise<any[]> {
    // Timeout alto: em instâncias com muito histórico em cache, a Evolution
    // pode levar 30s+ para montar a resposta de /group/fetchAllGroups.
    const res = await call<any>(
      `/group/fetchAllGroups/${encodeURIComponent(instanceName)}?getParticipants=false`,
      { method: "GET", timeoutMs: 60_000 },
    );
    return Array.isArray(res) ? res : (res?.groups ?? res?.data ?? []);
  },

  async findGroupInfo(instanceName: string, groupJid: string): Promise<any> {
    return call<any>(
      `/group/findGroupInfos/${encodeURIComponent(instanceName)}?groupJid=${encodeURIComponent(groupJid)}`,
      { method: "GET" },
    ).catch(() => null);
  },

  async groupParticipants(
    instanceName: string,
    groupJid: string,
  ): Promise<Array<{ id: string; jid?: string; admin?: string }>> {
    const info = await this.findGroupInfo(instanceName, groupJid);
    const raw = info?.participants ?? info?.data?.participants ?? info?.groupMetadata?.participants ?? [];
    return Array.isArray(raw) ? raw : [];
  },

  async createGroup(
    instanceName: string,
    subject: string,
    participants: string[],
    description?: string,
  ): Promise<any> {
    return call<any>(`/group/create/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: { subject, description, participants },
    });
  },

  async addGroupParticipants(instanceName: string, groupJid: string, participants: string[]): Promise<any> {
    // Timeout alto para grupos grandes: o custo do updateParticipant cresce
    // com o tamanho do grupo no Baileys/Evolution. Timeout curto abortava no
    // meio, gerava 409 no próximo catch e deixava a VPS sobrecarregada.
    return call<any>(
      `/group/updateParticipant/${encodeURIComponent(instanceName)}?groupJid=${encodeURIComponent(groupJid)}`,
      { method: "POST", body: { action: "add", participants }, timeoutMs: 90_000 },
    );
  },

  async checkWhatsappNumbers(
    instanceName: string,
    numbers: string[],
  ): Promise<Array<{ number: string; exists: boolean; jid?: string }>> {
    if (!numbers?.length) return [];
    const res = await call<any>(
      `/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`,
      { method: "POST", body: { numbers } },
    ).catch(() => []);
    const list = Array.isArray(res) ? res : (res?.data ?? res?.numbers ?? []);
    return list.map((row: any) => ({
      number: String(row?.number ?? row?.phone ?? "").replace(/\D/g, ""),
      exists: Boolean(row?.exists ?? row?.isRegistered ?? row?.registered),
      jid: row?.jid ?? row?.remoteJid ?? undefined,
    }));
  },
};

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
    // Sem fallback via /instance/fetchInstances: em servidores grandes esse
    // endpoint devolve a lista inteira e vira fonte de sobrecarga.
  }
  if (stateError && !state) throw stateError;
  if (statusFromState === "connecting") return { status: "connecting", state, usable: false };
  return { status: "offline", state: state ?? "not_connected", usable: false };
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

  // Se nem o probe respondeu, não dispare restart às cegas — em pico de
  // latência isso multiplicaria restarts por tick e poderia derrubar uma
  // sessão ainda viva.
  if (!before) {
    let latest: { status: EvolutionConnectionStatus; state?: string; usable: boolean } = {
      status: "connecting",
      state: "status_probe_failed",
      usable: false,
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      await wait(delayMs + attempt * 500);
      latest = await resolveEvolutionStatus(instanceName).catch(() => latest);
      if (latest.status === "online") return { ...latest, restarted: false };
    }
    return { ...latest, restarted: false };
  }

  // Reconexão automática usa restart/reload; /connect só em ação manual
  // (pode iniciar fluxo de QR no Baileys).
  const recheck = await resolveEvolutionStatus(instanceName).catch(() => null);
  if (recheck?.status === "online") return { ...recheck, restarted: false };

  await evolution.restart(instanceName).catch(() => undefined);

  let latest = before;
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
