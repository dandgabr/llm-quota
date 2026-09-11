import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) for authenticator-app MFA.
 *
 * The shared secret is held encrypted at rest (see core `encryptSecret`); this
 * module works with the decrypted secret only in memory, never logged. The
 * clock source is injectable so tests are deterministic.
 */

export type OTPAlgorithm = "SHA1" | "SHA256" | "SHA512";

/** Defaults per RFC 6238. */
export const TOTP_DEFAULTS = {
  digits: 6,
  period: 30,
  algorithm: "SHA1" as OTPAlgorithm,
};

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: OTPAlgorithm;
  /** Optional injectable clock (ms epoch) for tests. */
  nowMs?: () => number;
}

const HASH_MAP: Record<OTPAlgorithm, string> = {
  SHA1: "sha1",
  SHA256: "sha256",
  SHA512: "sha512",
};

/**
 * Generate a fresh TOTP shared secret (20 bytes, base64url). Note: RFC 6238
 * traditionally uses base32; Node's Buffer has no base32 encoding, so we store
 * and consume the secret in base64url, which is equally random and portable for
 * our internal storage (the authenticator app still receives a proper otpauth
 * URI built by the caller).
 */
export function generateTotpSecret(): string {
  return randomBytes(20).toString("base64url");
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Convert a base64url secret to the base32 form authenticator apps expect. */
export function secretToBase32(secretBase64Url: string): string {
  const bytes = Buffer.from(secretBase64Url, "base64url");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Build an `otpauth://` URI for a TOTP secret (uses base32, per RFC 6238).
 * The caller displays this as a QR to enroll the authenticator app.
 */
export function buildTotpUri(opts: {
  secretBase64Url: string;
  accountName: string;
  issuer?: string;
  algorithm?: OTPAlgorithm;
  digits?: number;
}): string {
  const params = new URLSearchParams({
    secret: secretToBase32(opts.secretBase64Url),
    algorithm: (opts.algorithm ?? TOTP_DEFAULTS.algorithm).toUpperCase(),
    digits: String(opts.digits ?? TOTP_DEFAULTS.digits),
    period: String(TOTP_DEFAULTS.period),
  });
  const label = opts.issuer
    ? `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.accountName)}`
    : encodeURIComponent(opts.accountName);
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Compute the TOTP 6/8-digit code for a given counter value (RFC 4226 HOTP). */
function hotp(secretBase64Url: string, counter: number, options: Required<Omit<TotpOptions, "nowMs">>): string {
  const algo = HASH_MAP[options.algorithm];
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const key = Buffer.from(secretBase64Url, "base64url");
  const digest = createHmac(algo, key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  const code = (bin % 10 ** options.digits).toString().padStart(options.digits, "0");
  return code;
}

/** Current TOTP code for a secret at a given time. */
export function generateTotp(secretBase64Url: string, opts: TotpOptions = {}): string {
  const o: Required<Omit<TotpOptions, "nowMs">> = {
    digits: opts.digits ?? TOTP_DEFAULTS.digits,
    period: opts.period ?? TOTP_DEFAULTS.period,
    algorithm: opts.algorithm ?? TOTP_DEFAULTS.algorithm,
  };
  const nowMs = opts.nowMs?.() ?? Date.now();
  const counter = Math.floor(nowMs / 1000 / o.period);
  return hotp(secretBase64Url, counter, o);
}

/** Verify a TOTP token with a ±window drift tolerance (default ±1 step). */
export function verifyTotp(
  secretBase64Url: string,
  token: string,
  opts: TotpOptions & { window?: number } = {},
): boolean {
  const o: Required<Omit<TotpOptions, "nowMs">> = {
    digits: opts.digits ?? TOTP_DEFAULTS.digits,
    period: opts.period ?? TOTP_DEFAULTS.period,
    algorithm: opts.algorithm ?? TOTP_DEFAULTS.algorithm,
  };
  const window = opts.window ?? 1;
  const nowMs = opts.nowMs?.() ?? Date.now();
  const current = Math.floor(nowMs / 1000 / o.period);
  for (let d = -window; d <= window; d += 1) {
    if (constantTimeEquals(hotp(secretBase64Url, current + d, o), token)) return true;
  }
  return false;
}

/** Constant-time string comparison to avoid timing side-channels. */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
