import { describe, expect, it } from "vitest";
import {
  hashToken,
  issueSessionToken,
  signSessionToken,
  verifySessionToken,
} from "../src/session.js";

describe("session tokens", () => {
  const SECRET = "x".repeat(32);

  it("issues an opaque token with a stored hash and an HMAC signature", () => {
    const { token, hash, signature } = issueSessionToken(SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).toBe(hashToken(token));
    expect(verifySessionToken(token, signature, SECRET)).toBe(true);
  });

  it("signs and verifies a token with SESSION_SECRET", () => {
    const { token } = issueSessionToken(SECRET);
    const sig = signSessionToken(token, SECRET);
    expect(verifySessionToken(token, sig, SECRET)).toBe(true);
    expect(verifySessionToken(token, "forged", SECRET)).toBe(false);
  });
});
