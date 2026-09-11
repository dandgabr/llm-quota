# ADR-009: Security Layer — Envelope Crypto, TOTP/WebAuthn, OIDC, Sessions, RBAC

**Status:** accepted

## Context

Phase 4 implements the security layer that Phase 5/6 (REST API, login/MFA) and
Phase 2/3 schemas depend on. ADR-001 §3 required envelope encryption for all
secrets; ADR-005 Q5 fixed the crypto shape (native `node:crypto` AEAD, per-value
DEK, KEK from env). This ADR pins the concrete auth design, the crypto payload
format, and the review outcomes so Phase 5 has a stable contract.

## Decisions

1. **Envelope encryption (format v1)** — implemented in `packages/core/src/crypto.ts`.
   Payload: `v1.<secretNonce>.<secretAuthTag>.<secretCiphertext>.<wrapNonce>.<wrappedDek>`
   (all base64). AES-256-GCM; 32-byte DEK per value wrapped by 32-byte KEK from
   `LLM_QUOTA_KEK`. `encryptSecret`/`decryptSecret` are the full API; secrets and
   keys are never logged. Unknown versions / malformed payloads fail safely.
2. **TOTP** — RFC 6238 in `packages/auth/src/totp.ts`: HMAC-SHA1/256/512, ±window,
   injectable clock, constant-time verify. Secrets stored base64url internally,
   exposed to authenticator apps via a base32 `otpauth://` builder
   (`secretToBase32`, `buildTotpUri`).
3. **WebAuthn** — `packages/auth/src/webauthn.ts`: challenge gen, assertion
   verification (ECDSA/P-256 COSE -7, SPKI import, clientData base64url), counter
   read-out. Challenge/origin/rpId binding and counter monotonicity enforced by
   the caller (Phase 6). Full registration attestation is Phase 6.
4. **OIDC** — `packages/auth/src/oidc.ts`: authorization-code + **PKCE S256** +
   **state** + pinned `redirect_uri` + optional nonce in the auth URL; token
   exchange (`client_secret_basic`), Bearer check, and `fetchUserInfo`. HTTP is
   injected. (id_token claim validation, GitHub/Discord OAuth2 adapters and the
   public-SPA client path are Phase 5/6 scope.)
5. **Sessions** — `packages/auth/src/session.ts`: opaque 256-bit token, SHA-256
   at rest, HMAC-SHA256 signer over `SESSION_SECRET` (≥ 32 chars) as
   defense-in-depth.
6. **RBAC** — `packages/auth/src/rbac.ts`: owner-passes, supervisor/admin read,
   admin-only mutate, role-rank precedence. `Role` sourced from `@llm-quota/shared`.
7. **DB secret at rest** — `PostgresConnectionStore` seals
   `connections.secret_cipher` via envelope; reads/writes owner-scoped under RLS.

## Review outcomes (ASVS L2, Phase 4)

A security + architecture review was performed; HIGH/MED defects fixed before
landing: WebAuthn clientData base64url handling (was raw JSON), OIDC PKCE/state
wired into the authorization URL, session token signed, TOTP base32 otpauth,
connection update/delete return row counts for RFC 7807 mapping.

## Consequences

- Secrets never plaintext at rest; envelope payload is versioned and auditable.
- Auth primitives are testable with injected clock/HTTP; no external key/HSM
  dependency (self-host v1).
- Phase 5 must consolidate the HTTP surface (one `HttpClient` with `get`+`post`
  in shared) and add the `userSessions` repository + `ResolvedPrincipal` mapper
  to set `app.*` RLS GUCs (as strings, transaction-scoped).
- MFA enrollment/attestation UI and OIDC userinfo->user upsert land in Phase 6.
