import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Server-side session token helpers (ADR-001/ADR-005). Tokens are opaque,
 * randomly generated and issued to clients; llm-quota stores the signed token
 * for `SESSION_SECRET` verification. `app.*` RLS settings (Phase 5) are derived
 * from the resolved session user.
 */

export interface SessionToken {
  token: string;
  /** SHA-256 hash of the token used at rest (never store the raw token). */
  hash: string;
  /** HMAC-SHA256 signature of the token (defense-in-depth; guards a leaked DB hash). */
  signature: string;
}

/** Issue an opaque session token, its at-rest hash and an HMAC signature. */
export function issueSessionToken(secret: string): SessionToken {
  const token = randomBytes(32).toString("base64url");
  const hash = hashToken(token);
  const signature = signSessionToken(token, secret);
  return { token, hash, signature };
}

/** Issue an opaque one-time invite/reset token and its at-rest hash. */
export function issueInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

/** SHA-256 digest of a token (for storage + lookup). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Sign a session token with `SESSION_SECRET` (HMAC-SHA256) to detect tampering.
 * The returned signature can be appended/compared separately; verification uses
 * `verifySignature` constant-time.
 */
export function signSessionToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
}

/** Constant-time verification of a token signature. */
export function verifySessionToken(token: string, expectedSignature: string, secret: string): boolean {
  const actual = createHmac("sha256", secret).update(token).digest("base64url");
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expectedSignature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validate that a `SESSION_SECRET` meets the minimum length. */
export function isValidSessionSecret(secret: string): boolean {
  return secret.length >= 32;
}
