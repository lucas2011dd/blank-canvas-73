import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Segredo isolado por suíte — nunca acessa segredo real do ambiente.
const TEST_SECRET = "test-secret-with-at-least-16-chars";

async function loadModule() {
  vi.resetModules();
  process.env.OAUTH_STATE_SECRET = TEST_SECRET;
  return await import("./oauth-state.server");
}

describe("oauth-state — HMAC + TTL", () => {
  const USER_ID = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("issue → verify roundtrip retorna o user_id", async () => {
    const { issueOAuthState, verifyOAuthState } = await loadModule();
    const state = issueOAuthState(USER_ID);
    expect(verifyOAuthState(state)).toBe(USER_ID);
  });

  it("state adulterado é rejeitado (timingSafeEqual falha)", async () => {
    const { issueOAuthState, verifyOAuthState } = await loadModule();
    const state = issueOAuthState(USER_ID);
    const tampered = state.slice(0, -2) + "aa";
    expect(verifyOAuthState(tampered)).toBeNull();
  });

  it("payload trocado para outro user_id é rejeitado (assinatura não bate)", async () => {
    const { issueOAuthState, verifyOAuthState } = await loadModule();
    const state = issueOAuthState(USER_ID);
    const [, ts, sig] = state.split(".");
    const attackerState = `99999999-2222-3333-4444-555555555555.${ts}.${sig}`;
    expect(verifyOAuthState(attackerState)).toBeNull();
  });

  it("expira após 10 minutos", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { issueOAuthState, verifyOAuthState } = await loadModule();
    const state = issueOAuthState(USER_ID);
    vi.setSystemTime(new Date("2026-01-01T00:10:01Z")); // +10min1s
    expect(verifyOAuthState(state)).toBeNull();
  });

  it("formato inválido (partes ≠ 3, null, vazio) ⇒ null", async () => {
    const { verifyOAuthState } = await loadModule();
    expect(verifyOAuthState(null)).toBeNull();
    expect(verifyOAuthState("")).toBeNull();
    expect(verifyOAuthState("only-one-part")).toBeNull();
    expect(verifyOAuthState("a.b")).toBeNull();
  });

  it("user_id não-UUID é rejeitado mesmo com assinatura válida", async () => {
    const { issueOAuthState, verifyOAuthState } = await loadModule();
    const state = issueOAuthState("not-a-uuid");
    // Assinatura confere, mas regex de UUID rejeita.
    expect(verifyOAuthState(state)).toBeNull();
  });

  it("segredo ausente/curto lança erro no issue", async () => {
    vi.resetModules();
    process.env.OAUTH_STATE_SECRET = "short";
    const { issueOAuthState } = await import("./oauth-state.server");
    expect(() => issueOAuthState(USER_ID)).toThrow(/OAUTH_STATE_SECRET/);
  });
});
