import { describe, expect, it } from "vitest";
import {
  buildTotpUri,
  generateTotp,
  generateTotpSecret,
  secretToBase32,
  verifyTotp,
} from "../src/totp.js";

// A fixed 20-byte secret, base64url-encoded.
const SECRET = Buffer.alloc(20, 1).toString("base64url");
const fixedNow = (epochSec: number) => () => epochSec * 1000;

describe("TOTP", () => {
  it("generates and verifies a current code", () => {
    const secret = generateTotpSecret();
    const now = fixedNow(1700000000);
    const code = generateTotp(secret, { nowMs: now });
    expect(verifyTotp(secret, code, { nowMs: now })).toBe(true);
  });

  it("rejects a wrong token in constant-time", () => {
    const secret = generateTotpSecret();
    const now = fixedNow(1700000000);
    expect(verifyTotp(secret, "000000", { nowMs: now })).toBe(false);
  });

  it("accepts tokens within the ±1 window", () => {
    const secret = generateTotpSecret();
    const base = fixedNow(1700000000);
    const prev = generateTotp(secret, { nowMs: fixedNow(1700000000 - 30) });
    const next = generateTotp(secret, { nowMs: fixedNow(1700000000 + 30) });
    expect(verifyTotp(secret, prev, { nowMs: base })).toBe(true);
    expect(verifyTotp(secret, next, { nowMs: base })).toBe(true);
  });

  it("produces 6 digits by default", () => {
    const code = generateTotp(SECRET, { nowMs: fixedNow(1700000000) });
    expect(code).toMatch(/^\d{6}$/);
  });

  it("supports SHA-256 and 8 digits", () => {
    const secret = generateTotpSecret();
    const now = fixedNow(1700000000);
    const code = generateTotp(secret, { nowMs: now, algorithm: "SHA256", digits: 8 });
    expect(code).toMatch(/^\d{8}$/);
    expect(verifyTotp(secret, code, { nowMs: now, algorithm: "SHA256", digits: 8 })).toBe(true);
  });

  it("converts a secret to valid base32 and builds an otpauth URI", () => {
    const secret = generateTotpSecret();
    const b32 = secretToBase32(secret);
    expect(b32).toMatch(/^[A-Z2-7]+=*$/);
    const uri = buildTotpUri({
      secretBase64Url: secret,
      accountName: "user@example.com",
      issuer: "llm-quota",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${b32}`);
    expect(uri).toContain("algorithm=SHA1");
  });
});
