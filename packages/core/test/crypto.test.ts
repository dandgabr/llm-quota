import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  decodeEnvelope,
  encryptSecret,
  generateDek,
  openSecret,
  parseKekFromEnv,
  sealSecret,
  unwrapDek,
  wrapDek,
} from "../src/crypto.js";

const KEK_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes
const kek = Buffer.from(KEK_B64, "base64");

describe("envelope encryption round-trips", () => {
  it("seals and opens a secret with the same DEK", () => {
    const dek = generateDek();
    const sealed = sealSecret("hunter2", dek);
    expect(openSecret(sealed, dek)).toBe("hunter2");
  });

  it("wraps and unwraps a DEK under a KEK", () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, kek);
    expect(unwrapDek(wrapped, kek).equals(dek)).toBe(true);
  });

  it("encrypts and decrypts full envelope through the canonical string", () => {
    const payload = encryptSecret("secret-value", kek);
    expect(decodeEnvelope(payload).version).toBe("v1");
    expect(decryptSecret(payload, kek)).toBe("secret-value");
  });

  it("produces unique ciphertext for the same secret (fresh nonce/DEK)", () => {
    const a = encryptSecret("same", kek);
    const b = encryptSecret("same", kek);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, kek)).toBe("same");
    expect(decryptSecret(b, kek)).toBe("same");
  });
});

describe("envelope encryption tamper detection", () => {
  it("throws when the KEK is wrong", () => {
    const payload = encryptSecret("v", kek);
    const wrong = Buffer.alloc(32, 1);
    expect(() => decryptSecret(payload, wrong)).toThrow();
  });

  it("throws when the payload ciphertext is tampered", () => {
    const payload = encryptSecret("v", kek);
    const parts = payload.split(".");
    parts[3] = Buffer.from("garbage-tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."), kek)).toThrow();
  });

  it("throws on unknown version", () => {
    const payload = encryptSecret("v", kek);
    expect(() => decodeEnvelope(`v9${payload.slice(2)}`)).toThrow(/Unsupported envelope version/);
  });

  it("throws on malformed payload", () => {
    expect(() => decodeEnvelope("v1.only")).toThrow();
  });
});

describe("parseKekFromEnv", () => {
  it("parses a valid base64 KEK from env", () => {
    const env = { LLM_QUOTA_KEK: KEK_B64 };
    expect(parseKekFromEnv(env).length).toBe(32);
  });

  it("throws when LLM_QUOTA_KEK is missing", () => {
    expect(() => parseKekFromEnv({})).toThrow(/LLM_QUOTA_KEK/);
  });

  it("throws when the KEK is not 32 bytes", () => {
    const env = { LLM_QUOTA_KEK: Buffer.from("short").toString("base64") };
    expect(() => parseKekFromEnv(env)).toThrow(/32 bytes/);
  });
});
