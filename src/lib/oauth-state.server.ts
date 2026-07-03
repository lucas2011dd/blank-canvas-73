// HMAC-assinado + TTL para o `state` do OAuth. Evita CSRF/troca de conta:
// atacante não consegue forjar um state válido para outro user_id sem o segredo,
// e states expiram em 10 min.
import { createHmac, timingSafeEqual } from "crypto";

const TTL_MS = 10 * 60 * 1000;

function secret(): string {
  const s = process.env.OAUTH_STATE_SECRET;
  if (!s || s.length < 16) throw new Error("OAUTH_STATE_SECRET ausente");
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", secret()).update(payload).digest());
}

export function issueOAuthState(userId: string): string {
  const ts = Date.now().toString(36);
  const payload = `${userId}.${ts}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyOAuthState(state: string | null | undefined): string | null {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [userId, ts, sig] = parts;
  const payload = `${userId}.${ts}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const issued = parseInt(ts, 36);
  if (!Number.isFinite(issued) || Date.now() - issued > TTL_MS) return null;
  // Sanidade: user_id parece UUID
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  return userId;
}
