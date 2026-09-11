/**
 * Envelope encryption for secrets at rest.
 *
 * Native `node:crypto` AEAD (AES-256-GCM) per ADR-001 §3 and ADR-005 Q5: each
 * secret is sealed with a fresh per-value Data Encryption Key (DEK); the DEK is
 * wrapped by the Key Encryption Key (KEK) sourced from the environment. Only the
 * versioned ciphertext + wrapped DEK persist; the KEK is never stored.
 *
 * Payload format (v1): `v1.<nonceB64>.<wrappedDekB64>.<authTagB64>.<ciphertextB64>`
 *
 * These helpers never log secret material, ciphertext or keys.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";

/** Supported versions of the sealed payload; only v1 is known today. */
export const CRYPTO_PAYLOAD_VERSION = "v1" as const;
type PayloadVersion = typeof CRYPTO_PAYLOAD_VERSION;

const GCM: CipherGCMTypes = "aes-256-gcm";
const DEK_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // GCM default

/** A freshly generated per-value Data Encryption Key (32 bytes). */
export type Dek = Buffer;

/** Generated once per seal; used to wrap a DEK under the KEK. */
export interface SealedDek {
  /** 12-byte nonce used for the wrap, base64. */
  nonce: string;
  /** Wrapped DEK ciphertext + tag, base64. */
  wrappedDek: string;
}

/** Raw AEAD output of sealing a secret with a DEK. */
export interface SealedSecret {
  /** 12-byte nonce, base64. */
  nonce: string;
  /** Authentication tag (GCM), base64. */
  authTag: string;
  /** Ciphertext (includes the secret), base64. */
  ciphertext: string;
}

const b64 = (buf: Buffer): string => buf.toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");

/** Generate a fresh random per-value Data Encryption Key. */
export function generateDek(): Dek {
  return randomBytes(DEK_BYTES);
}

/** Seal a secret with a DEK, producing nonce + authTag + ciphertext. */
export function sealSecret(secret: string, dek: Dek): SealedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(GCM, dek, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { nonce: b64(nonce), authTag: b64(authTag), ciphertext: b64(ciphertext) };
}

/** Open a sealed secret with the DEK; throws on tamper (GCM authentication). */
export function openSecret(sealed: SealedSecret, dek: Dek): string {
  const decipher = createDecipheriv(GCM, dek, unb64(sealed.nonce));
  decipher.setAuthTag(unb64(sealed.authTag));
  const plain = Buffer.concat([
    decipher.update(unb64(sealed.ciphertext)),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

/** Wrap a DEK under a KEK (AES-256-GCM), returning nonce + wrapped DEK. */
export function wrapDek(dek: Dek, kek: Dek): SealedDek {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(GCM, kek, nonce);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  return { nonce: b64(nonce), wrappedDek: b64(wrapped) };
}

/** Unwrap a DEK from `wrapDek` output; throws on tamper. */
export function unwrapDek(sealed: SealedDek, kek: Dek): Dek {
  const wrapped = unb64(sealed.wrappedDek);
  // GCM layout: ciphertext (32) + authTag (16).
  const ciphertext = wrapped.subarray(0, wrapped.length - 16);
  const authTag = wrapped.subarray(wrapped.length - 16);
  const decipher = createDecipheriv(GCM, kek, unb64(sealed.nonce));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encode a full v1 envelope payload into its canonical string form. */
export function encodeEnvelope(secrets: SealedSecret, wrapped: SealedDek): string {
  // v1.<secretNonce>.<secretAuthTag>.<secretCiphertext>.<wrapNonce>.<wrappedDek>
  return [
    CRYPTO_PAYLOAD_VERSION,
    secrets.nonce,
    secrets.authTag,
    secrets.ciphertext,
    wrapped.nonce,
    wrapped.wrappedDek,
  ].join(".");
}

/** Parse a v1 envelope payload; throws on unknown version / malformed input. */
export function decodeEnvelope(payload: string): {
  version: PayloadVersion;
  secrets: SealedSecret;
  wrapped: SealedDek;
} {
  const parts = payload.split(".");
  if (parts.length !== 6) throw new Error("Malformed envelope payload");
  const [version, secretNonce, secretAuthTag, secretCiphertext, wrapNonce, wrappedDek] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== CRYPTO_PAYLOAD_VERSION) {
    throw new Error(`Unsupported envelope version: ${version}`);
  }
  return {
    version: CRYPTO_PAYLOAD_VERSION,
    secrets: { nonce: secretNonce, authTag: secretAuthTag, ciphertext: secretCiphertext },
    wrapped: { nonce: wrapNonce, wrappedDek },
  };
}

/**
 * Encrypt a secret under a KEK and return the full v1 envelope string. Generates
 * a fresh DEK, seals the secret, wraps the DEK with the KEK. Safe to persist.
 */
export function encryptSecret(secret: string, kek: Dek): string {
  const dek = generateDek();
  const sealed = sealSecret(secret, dek);
  const wrapped = wrapDek(dek, kek);
  return encodeEnvelope(sealed, wrapped);
}

/**
 * Decrypt a v1 envelope string back to the plaintext secret. Throws on
 * tampering, wrong KEK, unknown version or malformed payload.
 */
export function decryptSecret(payload: string, kek: Dek): string {
  const { secrets, wrapped } = decodeEnvelope(payload);
  const dek = unwrapDek(wrapped, kek);
  return openSecret(secrets, dek);
}

/**
 * Parse a KEK from the environment's `LLM_QUOTA_KEK` value (base64-encoded
 * 32 bytes). Throws when missing or malformed; see `.env.example`.
 */
export function parseKekFromEnv(env: NodeJS.ProcessEnv = process.env): Dek {
  const raw = env.LLM_QUOTA_KEK;
  if (!raw) throw new Error("LLM_QUOTA_KEK is required for envelope encryption");
  const kek = unb64(raw.trim());
  if (kek.length !== DEK_BYTES) {
    throw new Error("LLM_QUOTA_KEK must decode to 32 bytes");
  }
  return kek;
}
