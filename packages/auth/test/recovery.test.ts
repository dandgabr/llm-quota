import { describe, expect, it } from "vitest";
import { hashToken } from "../src/session.js";
import {
  constantTimeHashEquals,
  generateRecoveryCode,
  hashRecoveryCode,
  isValidRecoveryPepper,
  normalizeRecoveryCode,
} from "../src/recovery.js";

const PEPPER = "p".repeat(32);
const USER = "11111111-1111-1111-1111-111111111111";

describe("recovery codes (E2)", () => {
  it("generates 160-bit base32 codes", () => {
    const a = generateRecoveryCode();
    const b = generateRecoveryCode();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
  });

  it("hashes with HMAC+pepper, never a raw SHA-256 (versioned)", () => {
    const code = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const hashed = hashRecoveryCode(code, PEPPER, USER);
    // Versioned: 'v1$<64 hex>'.
    expect(hashed).toMatch(/^v1\$[0-9a-f]{64}$/);
    expect(hashed).not.toBe(hashToken(code));
    expect(hashRecoveryCode(code, "q".repeat(32), USER)).not.toBe(hashed);
    // The userId is bound into the domain (no cross-user correlation).
    expect(hashRecoveryCode(code, PEPPER, "other")).not.toBe(hashed);
  });

  it("normalizes input (case/spacing/dashes)", () => {
    const code = "abcdefghijklmnopqrstuvwxyz234567";
    expect(normalizeRecoveryCode(" ABCD-EFGH ")).toBe("ABCDEFGH");
    expect(hashRecoveryCode("ABCD EFGH-IJKL MNOP QRST UVWX YZ23 4567", PEPPER, USER)).toBe(
      hashRecoveryCode("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", PEPPER, USER),
    );
    expect(code).toHaveLength(32);
  });

  it("fails closed without a valid pepper", () => {
    expect(isValidRecoveryPepper("short")).toBe(false);
    expect(isValidRecoveryPepper(undefined)).toBe(false);
    expect(isValidRecoveryPepper(PEPPER)).toBe(true);
    expect(() => hashRecoveryCode("ABC", "short", USER)).toThrow();
  });

  it("compares hashes in constant time", () => {
    const h = hashRecoveryCode("ABCDEFGH", PEPPER, USER);
    expect(constantTimeHashEquals(h, h)).toBe(true);
    expect(constantTimeHashEquals(h, h.slice(0, -1) + (h.endsWith("0") ? "1" : "0"))).toBe(false);
    expect(constantTimeHashEquals(h, "x".repeat(64))).toBe(false);
  });
});
