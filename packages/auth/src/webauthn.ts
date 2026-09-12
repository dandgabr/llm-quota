import { createHash, randomBytes, webcrypto } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;
type BufferSource = webcrypto.BufferSource;

/**
 * WebAuthn (FIDO2) helpers — challenge generation and assertion verification.
 *
 * llm-quota stores the credential (credentialId, publicKey, counter) and uses
 * these to run a registration challenge and to verify a signature assertion
 * against the stored public key. Verification uses the Web Crypto API
 * (ECDSA/P-256, COSE -7 ES256) so it is portable and unit-testable with a
 * generated key pair.
 */

export interface WebAuthnCredential {
  credentialId: string; // base64url
  /** SPKI DER encoding of the P-256 public key, base64url. */
  publicKey: string;
  /** COSE algorithm id (-7 = ES256). */
  algorithm: number;
  counter: number;
  transports?: string[];
}

export interface WebAuthnAssertion {
  credentialId: string;
  /** ClientData JSON, base64url-encoded as delivered by the authenticator. */
  clientDataJson: string;
  /** Signature over authenticatorData || clientDataHash (base64url). */
  signature: string;
  /** Raw authenticator data (base64url). */
  authenticatorData: string;
}

/** Generate a random registration/authentication challenge (base64url). */
export function generateWebAuthnChallenge(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Decode the authenticator's base64url ClientData JSON into raw bytes (the form
 * both JSON.parse and the SHA-256 must operate on — webauthn requires hashing
 * the raw JSON bytes, and transport is base64url).
 */
export function decodeClientDataBytes(clientDataJsonBase64Url: string): Buffer {
  return Buffer.from(clientDataJsonBase64Url, "base64url");
}

/** SHA-256 of the raw client data JSON bytes (WebAuthn requirement). */
export function hashClientDataJson(clientDataJsonBase64Url: string): Buffer {
  return createHash("sha256")
    .update(decodeClientDataBytes(clientDataJsonBase64Url))
    .digest();
}

export interface ParsedClientData {
  type: string;
  challenge: string;
  origin: string;
}

/** Parse the (base64url) ClientData JSON into its fields. */
export function parseClientData(clientDataJsonBase64Url: string): ParsedClientData {
  const raw = decodeClientDataBytes(clientDataJsonBase64Url);
  return JSON.parse(raw.toString("utf8")) as ParsedClientData;
}

/** Result of an assertion verification, including the parsed client data. */
export interface VerifyResult {
  verified: boolean;
  clientData: ParsedClientData;
  /** The counter value read from authenticatorData (bytes 33..36). */
  authenticatorCounter: number;
}

/** Server-held expectations bound to the issued challenge (must be enforced). */
export interface WebAuthnExpectations {
  /** The challenge the server issued for this ceremony (stored with a TTL). */
  expectedChallenge: string;
  /** Exact origin allow-list (e.g. ["https://app.example.com"]). */
  expectedOrigins: string[];
  /** The relying-party id (effective domain, e.g. "example.com"). */
  expectedRpId: string;
  /** Require user-present (UP) flag; default true. */
  requireUserPresent?: boolean;
  /** Require user-verified (UV) flag; default false. */
  requireUserVerified?: boolean;
}

/**
 * Verify a WebAuthn assertion end-to-end:
 *  - decodes + parses clientData (must be `webauthn.get`)
 *  - enforces the server-held `expectations`: challenge match, origin
 *    allow-list and the rpIdHash embedded in authenticatorData
 *  - verifies the ECDSA/P-256 signature over `authenticatorData || hash(clientData)`
 *  - enforces the UP/UV flags and returns the authenticator counter so the
 *    caller can enforce monotonicity against the stored credential.
 */
export async function verifyWebAuthnAssertion(
  credential: WebAuthnCredential,
  assertion: WebAuthnAssertion,
  expectations: WebAuthnExpectations,
): Promise<VerifyResult> {
  const fail = (clientData: ParsedClientData): VerifyResult => ({
    verified: false,
    clientData,
    authenticatorCounter: -1,
  });
  const clientData = parseClientData(assertion.clientDataJson);
  if (clientData.type !== "webauthn.get") return fail(clientData);
  if (clientData.challenge !== expectations.expectedChallenge) return fail(clientData);
  if (!expectations.expectedOrigins.includes(clientData.origin)) return fail(clientData);

  const authData = Buffer.from(assertion.authenticatorData, "base64url");
  // rpIdHash = SHA-256(relying party id), bytes 0..31 of authenticator data.
  const rpIdHash = createHash("sha256").update(expectations.expectedRpId).digest();
  if (authData.length < 37 || !authData.subarray(0, 32).equals(rpIdHash)) {
    return fail(clientData);
  }
  const flags = authData[32]!;
  const upPresent = (flags & 0x01) !== 0; // UP
  const uvVerified = (flags & 0x04) !== 0; // UV
  if (!upPresent && expectations.requireUserPresent !== false) return fail(clientData);
  if (expectations.requireUserVerified && !uvVerified) return fail(clientData);

  const key = await importPublicKey(credential.publicKey, credential.algorithm);
  const clientDataHash = hashClientDataJson(assertion.clientDataJson);
  const signedData = Buffer.concat([authData, clientDataHash]);

  const signature = Buffer.from(assertion.signature, "base64url");
  const verified = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature as unknown as BufferSource,
    signedData as unknown as BufferSource,
  );

  return {
    verified,
    clientData,
    authenticatorCounter: readAuthenticatorCounter(authData),
  };
}

/** Read the signature counter from authenticator data (bytes 33..36). */
function readAuthenticatorCounter(authData: Buffer): number {
  if (authData.length < 37) return -1;
  return authData.readUInt32BE(33);
}

/**
 * Import an ES256 (COSE -7) public key stored as SPKI DER (base64url).
 * Uses SPKI rather than raw x||y so leading zero bytes in a coordinate do
 * not truncate the buffer.
 */
async function importPublicKey(
  publicKeyBase64Url: string,
  algorithm: number,
): Promise<CryptoKey> {
  if (algorithm !== -7) {
    throw new Error(`Unsupported COSE algorithm: ${algorithm}`);
  }
  const spki = Buffer.from(publicKeyBase64Url, "base64url");
  return webcrypto.subtle.importKey(
    "spki",
    spki as unknown as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  ) as Promise<CryptoKey>;
}

/** Export a P-256 public key as SPKI DER, base64url-encoded. */
export async function exportPublicKeySpki(publicKey: CryptoKey): Promise<string> {
  const spki = await webcrypto.subtle.exportKey("spki", publicKey);
  return Buffer.from(spki as ArrayBuffer).toString("base64url");
}
