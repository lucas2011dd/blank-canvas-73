import { describe, expect, it } from "vitest";
import {
  evolutionStateToStatus,
  extractEvolutionConnectionState,
  extractEvolutionErrorCode,
  isPairingLostEvolutionError,
  isPairingLostEvolutionState,
  payloadIndicatesPairingLost,
} from "./state.server";

describe("evolutionStateToStatus — classificação de estados", () => {
  it.each([
    ["open", "online"],
    ["ONLINE", "online"],
    ["connected", "online"],
    ["authenticated", "online"],
    ["ready", "online"],
  ])("%s ⇒ online", (input, expected) => {
    expect(evolutionStateToStatus(input)).toBe(expected);
  });

  it.each([
    ["offline", "offline"],
    ["disconnected", "offline"],
    ["logged_out", "offline"],
    ["device_removed", "offline"],
    ["unauthorized", "offline"],
    ["failed_something", "offline"],
    ["forbidden_401", "offline"],
  ])("%s ⇒ offline", (input, expected) => {
    expect(evolutionStateToStatus(input)).toBe(expected);
  });

  it.each([
    ["connecting", "connecting"],
    ["qr", "connecting"],
    ["QRCODE", "connecting"],
    ["pairing", "connecting"],
    ["close", "connecting"],
    ["stream:error", "connecting"],
  ])("%s ⇒ connecting", (input, expected) => {
    expect(evolutionStateToStatus(input)).toBe(expected);
  });

  // Casos de borda: undefined/null/vazio ⇒ offline (default seguro)
  it.each([[undefined], [""], ["   "]])("empty (%s) ⇒ offline", (input) => {
    expect(evolutionStateToStatus(input as string | undefined)).toBe("offline");
  });

  it("desconhecido ⇒ offline (fallback)", () => {
    expect(evolutionStateToStatus("something-weird")).toBe("offline");
  });
});

describe("extractEvolutionConnectionState — normaliza vários formatos de payload", () => {
  it("lê instance.state", () => {
    expect(extractEvolutionConnectionState({ instance: { state: "open" } })).toBe("open");
  });
  it("lê data.instance.status como fallback", () => {
    expect(extractEvolutionConnectionState({ data: { instance: { status: "close" } } })).toBe("close");
  });
  it("prioriza instance.state sobre state raiz", () => {
    expect(
      extractEvolutionConnectionState({ instance: { state: "open" }, state: "close" }),
    ).toBe("open");
  });
  it("retorna undefined quando não há campo conhecido", () => {
    expect(extractEvolutionConnectionState({ foo: "bar" })).toBeUndefined();
  });
  it("ignora strings vazias", () => {
    expect(extractEvolutionConnectionState({ state: "   ", status: "open" })).toBe("open");
  });
});

describe("extractEvolutionErrorCode — captura códigos WhatsApp", () => {
  it("detecta 515 em objeto", () => {
    expect(extractEvolutionErrorCode({ code: "515" })).toBe(515);
  });
  it("detecta 401 em string livre", () => {
    expect(extractEvolutionErrorCode("Request failed with 401 unauthorized")).toBe(401);
  });
  it("detecta stream:error 515", () => {
    expect(extractEvolutionErrorCode("stream:error something 515")).toBe(515);
  });
  it("retorna null quando não há match", () => {
    expect(extractEvolutionErrorCode({ msg: "ok" })).toBeNull();
    expect(extractEvolutionErrorCode(null)).toBeNull();
  });
});

describe("payloadIndicatesPairingLost — falso positivo é CRÍTICO", () => {
  it("device_removed explícito ⇒ true", () => {
    expect(payloadIndicatesPairingLost({ state: "device_removed" })).toBe(true);
  });
  it("statusReason logged_out ⇒ true", () => {
    expect(payloadIndicatesPairingLost({ statusReason: "logged_out" })).toBe(true);
  });
  it("state 'close' sem razão explícita ⇒ false (evita falso positivo)", () => {
    expect(payloadIndicatesPairingLost({ state: "close" })).toBe(false);
  });
  it("state 'open' ⇒ false", () => {
    expect(payloadIndicatesPairingLost({ state: "open" })).toBe(false);
  });
  it("payload vazio ⇒ false", () => {
    expect(payloadIndicatesPairingLost({})).toBe(false);
    expect(payloadIndicatesPairingLost(null)).toBe(false);
  });
});

describe("isPairingLostEvolutionState / Error — helpers de decisão", () => {
  it.each(["device_removed", "logged_out", "logout", "unpaired"])(
    "%s ⇒ pairing lost",
    (s) => expect(isPairingLostEvolutionState(s)).toBe(true),
  );
  it("close NÃO indica pairing lost", () => {
    expect(isPairingLostEvolutionState("close")).toBe(false);
  });
  it("isPairingLostEvolutionError percorre Error", () => {
    const err = new Error("session device_removed by user");
    expect(isPairingLostEvolutionError(err)).toBe(true);
  });
  it("isPairingLostEvolutionError com erro trivial ⇒ false", () => {
    expect(isPairingLostEvolutionError(new Error("network hiccup"))).toBe(false);
  });
});
