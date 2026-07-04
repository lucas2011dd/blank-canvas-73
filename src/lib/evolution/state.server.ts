// Normalização/classificação de estados e erros da Evolution API.
// Funções puras (sem I/O), reutilizadas por evolution client, webhook e tick.

export type EvolutionConnectionStatus = "online" | "offline" | "connecting";

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function extractEvolutionErrorCode(source: unknown): number | null {
  const haystack = typeof source === "object" && source !== null
    ? JSON.stringify(source, Object.getOwnPropertyNames(source))
    : String(source ?? "");
  const patterns = [
    /"code"\s*:\s*"?515"?/,
    /stream:error[^"]*"?515/i,
    /\b515\b/,
    /"statusReason"\s*:\s*"?401"?/i,
    /"code"\s*:\s*"?401"?/,
    /\b401\b/,
    /\b428\b/,
    /\b408\b/,
    /\b500\b/,
    /\b503\b/,
  ];
  for (const re of patterns) {
    const m = haystack.match(re);
    if (m) {
      const n = Number(m[0].replace(/\D/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
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
  const normalizedReason = String(reason ?? "").toLowerCase();
  if (
    normalizedReason.includes("device_removed") ||
    normalizedReason.includes("logged_out") ||
    normalizedReason.includes("logged out") ||
    normalizedReason.includes("logout") ||
    normalizedReason.includes("unpaired")
  ) return true;

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
    normalized.includes("device_removed") ||
    normalized.includes("logged_out") ||
    normalized.includes("logged out") ||
    normalized.includes("unpaired")
  );
}

export function isPairingLostEvolutionError(error: unknown): boolean {
  const haystack = typeof error === "object" && error !== null
    ? JSON.stringify(error, Object.getOwnPropertyNames(error)).toLowerCase()
    : String(error ?? "").toLowerCase();
  const explicitPairingLoss =
    haystack.includes("device_removed") ||
    haystack.includes("logged_out") ||
    haystack.includes("logged out") ||
    haystack.includes("logout") ||
    haystack.includes("unpaired") ||
    haystack.includes("pairing_lost") ||
    haystack.includes("reauth_required");

  return (
    isPairingLostEvolutionState(haystack) ||
    explicitPairingLoss
  );
}

export function isTransientEvolutionError(error: unknown): boolean {
  if (isPairingLostEvolutionError(error)) return false;
  const haystack = typeof error === "object" && error !== null
    ? JSON.stringify(error, Object.getOwnPropertyNames(error)).toLowerCase()
    : String(error ?? "").toLowerCase();
  const isPermanent = (
    haystack.includes("device_removed") ||
    haystack.includes("logged_out") ||
    haystack.includes("logged out") ||
    haystack.includes("logout") ||
    haystack.includes("unpaired")
  );
  if (isPermanent) return false;
  return (
    haystack.includes("515") ||
    haystack.includes("428") ||
    haystack.includes("stream:error") ||
    haystack.includes("stream error") ||
    haystack.includes("connection closed") ||
    haystack.includes("connection close") ||
    haystack.includes("instance is not connected") ||
    haystack.includes("the instance is not connected") ||
    haystack.includes("not_connected") ||
    haystack.includes("not connected") ||
    haystack.includes("401") ||
    haystack.includes("unauthoriz") ||
    haystack.includes("forbidden") ||
    haystack.includes("timed out") ||
    haystack.includes("timeout") ||
    haystack.includes("socket") ||
    haystack.includes("network") ||
    haystack.includes("fetch failed") ||
    haystack.includes("evolution temporariamente") ||
    haystack.includes("temporarily unavailable")
  );
}
