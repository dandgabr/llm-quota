import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * MFA recovery codes (E2 / ADR-016 hardening).
 *
 * Codes are high-entropy (160 bits) and stored only as `HMAC-SHA256(pepper,
 * domain || userId || code)`. The pepper never lives in the database; a missing
 * or short pepper fails closed (no silent fallback to an unpeppered hash).
 * Binding the userId into the HMAC domain removes cross-user correlation.
 */

export const RECOVERY_CODE_COUNT = 10;
/** 20 random bytes = 160 bits, rendered as 32 base32 chars (A-Z2-7). */
const RECOVERY_CODE_BYTES = 20;
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Minimum pepper length; anything shorter is rejected (fail-closed). */
export const MIN_PEPPER_LENGTH = 32;

/** True when the pepper satisfies the minimum length policy. */
export function isValidRecoveryPepper(pepper: string | undefined): pepper is string {
  return typeof pepper === "string" && pepper.length >= MIN_PEPPER_LENGTH;
}

/** Generate one recovery code: 32 uppercase base32 chars (160 bits). */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Normalize user input: uppercase, strip non-base32 (spaces, dashes). */
export function normalizeRecoveryCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

/**
 * Hash a recovery code for storage/comparison. Throws when the pepper is
 * invalid so no code path can ever store/verify an unpeppered hash. The stored
 * value is versioned (`v1$<keyId>$<hmac>`) so peppers can be rotated.
 */
export function hashRecoveryCode(code: string, pepper: string, userId: string, keyId = "v1"): string {
  if (!isValidRecoveryPepper(pepper)) {
    throw new Error("RECOVERY_PEPPER is missing or too short (>= 32 chars required)");
  }
  const hmac = createHmac("sha256", pepper)
    .update(`v1\u0000${userId}\u0000${normalizeRecoveryCode(code)}`)
    .digest("hex");
  return `${keyId}$${hmac}`;
}

/** Constant-time comparison of two hex hashes. */
export function constantTimeHashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
