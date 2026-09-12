import { describe, expect, it } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import {
  exportPublicKeySpki,
  generateWebAuthnChallenge,
  hashClientDataJson,
  parseClientData,
  verifyWebAuthnAssertion,
  type WebAuthnAssertion,
  type WebAuthnCredential,
} from "../src/webauthn.js";

type CryptoKey = webcrypto.CryptoKey;
type BufferSource = webcrypto.BufferSource;

const RP_ID = "example.com";
const ORIGIN = "https://app.example.com";
const expectations = (challenge: string) => ({
  expectedChallenge: challenge,
  expectedOrigins: [ORIGIN],
  expectedRpId: RP_ID,
});

/** Build a signed assertion for a credential using the Web Crypto API (ES256). */
async function buildAssertion(
  privateKey: CryptoKey,
  credentialId: string,
  origin: string,
  challenge: string,
): Promise<WebAuthnAssertion> {
  const clientData = {
    type: "webauthn.get",
    challenge,
    origin,
  };
  const clientDataJson = Buffer.from(JSON.stringify(clientData)).toString("base64url");
  const clientDataHash = hashClientDataJson(clientDataJson);
  // RFC-ish authenticator data: 32-byte rpIdHash (SHA-256 of the RP id) + flags + counter.
  const rpIdHash = createHash("sha256").update(RP_ID).digest();
  const flags = new Uint8Array(1).fill(1); // user-present
  const counter = Buffer.from([0, 0, 0, 1]); // 4 bytes
  const authenticatorData = Buffer.concat([
    Buffer.from(rpIdHash),
    Buffer.from(flags),
    counter,
  ]);
  const data = Buffer.concat([authenticatorData, clientDataHash]);
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    data as unknown as BufferSource,
  );
  return {
    credentialId,
    clientDataJson,
    signature: Buffer.from(signature).toString("base64url"),
    authenticatorData: authenticatorData.toString("base64url"),
  };
}

describe("WebAuthn", () => {
  it("generates a base64url challenge", () => {
    const c = generateWebAuthnChallenge();
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes client data (SHA-256)", () => {
    const h = hashClientDataJson("{}");
    expect(h.length).toBe(32);
  });

  it("parses client data", () => {
    const json = Buffer.from('{"type":"webauthn.get","challenge":"c","origin":"https://x"}').toString("base64url");
    const d = parseClientData(json);
    expect(d.type).toBe("webauthn.get");
    expect(d.challenge).toBe("c");
    expect(d.origin).toBe("https://x");
  });

  it("verifies a valid assertion with the stored public key", async () => {
    const pair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const challenge = generateWebAuthnChallenge();
    const credentialId = "cred-1";
    const assertion = await buildAssertion(pair.privateKey as CryptoKey, credentialId, ORIGIN, challenge);
    const publicKey = await exportPublicKeySpki(pair.publicKey as CryptoKey);
    const credential: WebAuthnCredential = {
      credentialId,
      publicKey,
      algorithm: -7,
      counter: 1,
    };
    expect((await verifyWebAuthnAssertion(credential, assertion, expectations(challenge))).verified).toBe(true);
  });

  it("rejects a replayed/wrong challenge and a foreign origin", async () => {
    const pair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const challenge = generateWebAuthnChallenge();
    const assertion = await buildAssertion(pair.privateKey as CryptoKey, "c", ORIGIN, challenge);
    const credential: WebAuthnCredential = {
      credentialId: "c",
      publicKey: await exportPublicKeySpki(pair.publicKey as CryptoKey),
      algorithm: -7,
      counter: 1,
    };
    const wrongChallenge = await verifyWebAuthnAssertion(
      credential,
      assertion,
      expectations("other-challenge"),
    );
    expect(wrongChallenge.verified).toBe(false);
    const foreignOrigin = await verifyWebAuthnAssertion(credential, assertion, {
      expectedChallenge: challenge,
      expectedOrigins: ["https://other.example"],
      expectedRpId: RP_ID,
    });
    expect(foreignOrigin.verified).toBe(false);
    const wrongRpId = await verifyWebAuthnAssertion(credential, assertion, {
      expectedChallenge: challenge,
      expectedOrigins: [ORIGIN],
      expectedRpId: "other.example",
    });
    expect(wrongRpId.verified).toBe(false);
  });

  it("rejects an assertion with the wrong type", async () => {
    const pair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const assertion = await buildAssertion(pair.privateKey as CryptoKey, "c", "https://app", "ch");
    const credential: WebAuthnCredential = {
      credentialId: "c",
      publicKey: await exportPublicKeySpki(pair.publicKey as CryptoKey),
      algorithm: -7,
      counter: 1,
    };
    // Override client-data type to something unexpected.
    const bad = {
      ...assertion,
      clientDataJson: Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge: "ch", origin: "https://app" }),
      ).toString("base64url"),
    };
    expect((await verifyWebAuthnAssertion(credential, bad, expectations("ch"))).verified).toBe(false);
  });

  it("rejects an assertion signed with the wrong key", async () => {
    const [a, b] = await Promise.all([
      webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
      webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
    ]);
    const assertion = await buildAssertion(a.privateKey as CryptoKey, "c", "https://app", "ch");
    const credential: WebAuthnCredential = {
      credentialId: "c",
      publicKey: await exportPublicKeySpki(b.publicKey as CryptoKey),
      algorithm: -7,
      counter: 1,
    };
    expect((await verifyWebAuthnAssertion(credential, assertion, expectations("ch"))).verified).toBe(false);
  });
});
