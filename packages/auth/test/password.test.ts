import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  isValidPassword,
  parsePasswordHash,
  verifyPassword,
} from "../src/password.js";

describe("password hashing (scrypt)", () => {
  it("hashes and verifies a password (round-trip)", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$scrypt$ln=")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password entirely", hash)).toBe(false);
  });

  it("produces a unique salt per hash (same password, different digest)", async () => {
    const a = await hashPassword("same-password-123");
    const b = await hashPassword("same-password-123");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password-123", a)).toBe(true);
    expect(await verifyPassword("same-password-123", b)).toBe(true);
  });

  it("parses the stored parameters (enables future param upgrades)", async () => {
    const hash = await hashPassword("upgrade-me-please");
    const parsed = parsePasswordHash(hash);
    expect(parsed?.params.N).toBe(DEFAULT_SCRYPT_PARAMS.N);
    expect(parsed?.params.r).toBe(DEFAULT_SCRYPT_PARAMS.r);
    expect(parsed?.params.p).toBe(DEFAULT_SCRYPT_PARAMS.p);
  });

  it("rejects malformed stored hashes", async () => {
    expect(parsePasswordHash("not-a-phc-string")).toBeNull();
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("enforces the length policy", () => {
    expect(isValidPassword("short")).toBe(false);
    expect(isValidPassword("a".repeat(12))).toBe(true);
    expect(isValidPassword("a".repeat(1025))).toBe(false);
  });
});
