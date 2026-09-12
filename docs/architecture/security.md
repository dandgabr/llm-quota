# Security design

Status: **implemented** (Phases 4–8 plus the production-wiring hardening pass —
see [ADR-009](adr/ADR-009-security-layer-envelope-auth.md) and
[ADR-012](adr/ADR-012-production-runtime-wiring-and-hardening.md)). Items that
are documented but **not** implemented are called out explicitly; do not assume
them.

## Session & token model (current reality)

- Sessions are **opaque 256-bit random tokens** presented as
  `Authorization: Bearer <token>`. The DB stores only the SHA-256 hash
  (`user_sessions.token_hash`) — the plaintext token is unrecoverable from a
  database read.
- **Signature**: each session also stores an HMAC-SHA256 signature
  (`user_sessions.signature`, migration `0002`) computed over `SESSION_SECRET`.
  The auth middleware verifies it **on every request** when `SESSION_SECRET`
  is set — a leaked hash table alone cannot mint valid sessions
  (defense-in-depth per ADR-009).
- **Client storage**: the SPA keeps the bearer token in **`localStorage`**.
  This is an accepted, documented trade-off: it exposes the token to any XSS
  in the SPA, mitigated by the edge CSP (`default-src 'self'`, no third-party
  script origins) and the short dev-session cap (≤ 24 h). There are **no
  HttpOnly cookies today**; earlier documents claiming HttpOnly/Secure cookies
  were wrong.
- Revocation: `DELETE /v1/sessions/:id` (owner-scoped); expired/revoked
  sessions fail the principal resolution → `401`.

## Dev-only authentication endpoints (fail-closed)

- `POST /auth/issue-session`, `GET /auth/oidc/authorize`,
  `GET /auth/mfa/totp/challenge`, `GET /auth/mfa/webauthn/challenge` are
  **development/testing scaffolding**.
- Gate is fail-closed: they respond `403 problem+json` unless **both**
  `ENABLE_DEV_SESSION=1` **and** `NODE_ENV` ≠ production. The production
  compose leaves `ENABLE_DEV_SESSION` empty, so the shipped topology cannot
  serve them even if misconfigured.
- `issue-session` caps lifetime at 24 h and requires a valid `SESSION_SECRET`
  (≥ 32 chars) — no hardcoded fallback.

**Known limitation (unimplemented):** there is **no production authentication
path yet**. OIDC **id_token validation**, server-side **state/PKCE-verifier
persistence**, and the **MFA verify/enrollment endpoints** are specified in
[ADR-009](adr/ADR-009-security-layer-envelope-auth.md) but not implemented;
`OIDC_*` env vars are reserved placeholders. The primitives (PKCE pair
generation, OIDC client, TOTP, WebAuthn assertion verification) exist in
`packages/auth` and are unit-tested; only the endpoint wiring is missing.

## Transport security

| Link                  | Policy                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Browser ↔ edge        | TLS **1.3-only** (`ssl_protocols TLSv1.3`, AEAD ciphers), HTTP/3 (QUIC) preferential via the `edge` profile, automatic `h2 → h1.1` fallback. Headers: HSTS `max-age=63072000; includeSubDomains`, CSP `default-src 'self'`, `X-Content-Type-Options`, `X-Frame-Options: DENY`. |
| Browser ↔ api (direct)| When `TLS_CERT_PATH`/`TLS_KEY_PATH` are set, the Node listener itself is **TLS 1.3-only** and adds HSTS. Local test certs only (`scripts/cert-local.sh`); `local.*` certs are refused in `NODE_ENV=production`. |
| api ↔ postgres        | Internal compose network. The shipped `DATABASE_URL` sets no TLS parameters; enforcing the `sslmode=verify-full` + TLS 1.3 posture on this hop is a **hardening backlog item**, not wired today. |

See [ADR-008](adr/ADR-008-rest-api-tls-quic-query.md) and
[api-conventions](api-conventions.md) for the transport contract details.

## CORS

- Exact **origin allow-list**: `WEB_ORIGIN` plus the dev ports
  `localhost:5173` / `localhost:4173`. Non-listed origins get no CORS grant.
- `OPTIONS` **preflight is answered**, and **QUERY is in the allow-methods** —
  browsers cannot emit `QUERY` (RFC 10008) without a successful preflight,
  so the history read works from the SPA while `GET` remains the alias.

## Rate limiting & input limits

- **App layer**: per-IP limiter on `/auth/*` — **30 requests/minute**, in-process
  (per API instance; horizontal scaling multiplies the budget).
- **Edge** (`--profile edge`): nginx `limit_req` **10 r/m** (burst 20) per IP on
  `/auth/` — the global backstop.
- **Body cap**: **64 KB** request bodies; larger payloads are rejected before
  reaching handlers.
- `QUERY` (safe + idempotent, RFC 10008) is used for body-based reads, keeping
  the read surface out of the CSRF-relevant mutation verbs.

## Envelope encryption (secrets at rest)

All connection secrets are encrypted at rest:

- A fresh random **DEK** (data encryption key, 32 bytes) is generated per secret value.
- The payload is encrypted with **AES-256-GCM** (authenticated).
- The DEK is wrapped by a **KEK** (key-encryption key) from `LLM_QUOTA_KEK`
  (base64, 32 bytes); the KEK is **never** stored in the database.

Concrete format (v1, `node:crypto` AEAD per ADR-005 Q5, implemented in
`packages/core/src/crypto.ts`):
`v1.<secretNonce>.<secretAuthTag>.<secretCiphertext>.<wrapNonce>.<wrappedDek>`
(all base64). `encryptSecret` / `decryptSecret` handle the round-trip; unknown
versions / malformed payloads fail safely; secrets and keys are **never
logged**. Key-rotation procedure (concept) is in the
[runbook](../runbook.md#6-kek-rotation-envelope-encryption-concept).

**DTO discipline**: `GET /v1/connections` returns a safe projection
(`id`, `providerKey`, `label`, `connectionType`, `status`, `createdAt`) —
`secretCipher` is **never** serialized, and the plaintext secret submitted at
connection creation is never echoed.

## RBAC & object-level security

Profiles: `user`, `supervisor`, `admin`.

- `admin` — everything a user can do, plus user management and identity-provider
  administration.
- `supervisor` — manages **own** providers/connections **and has a read-only
  view** of other users' spend/quota (`GET /v1/quotas/summary` requires
  supervisor+; month-to-date totals by currency).
- `user` — connects providers and views own quotas/history/sessions.

Access control is enforced server-side at the object level (OWASP BOLA / IDOR
mitigation), not just by route. RBAC helpers live in `packages/auth/src/rbac.ts`
(`canViewActor`, `canManageConnections`, `hasRole`).

## Row-Level Security (tenant isolation)

Tenant tables (users, connections, quota_sessions, quota_snapshots,
spending_aggregates, user_sessions, totp_secrets, webauthn_credentials) are
RLS-enabled and `FORCE`-locked. Two mechanics make it real in the shipped
topology:

1. **Non-superuser pool** — the API connects as `llmquota_app`
   (provisioned by `docker/pg/init-prod.sh`; migration `0001` creates the role
   **without** a password, provisioning sets it). The cluster superuser would
   bypass RLS entirely and is reserved for migrations/seed.
2. **Per-request GUCs** — the auth middleware wraps data access in
   `withRlsContext`, issuing `SET LOCAL app.user_id`,
   `app.is_admin`, `app.is_supervisor_admin` inside each transaction so
   policies scope reads/writes per tenant while preserving supervisor/admin
   read paths.

**Collector policy** (migration `0002`): the in-process collector enumerates
connections cross-tenant by setting `app.is_collector = 'true'` — dedicated
policies grant it the narrow `SELECT`/`DELETE` surface it needs — and then
performs its snapshot/aggregate **writes per owner** under a normal per-user
RLS context, so a collector bug cannot write across tenants.

Reference/shared data (quota_providers, identity_providers, fx_rates) is not
tenant-scoped by design.

## Threat-model deltas & known limitations

| Item | Status |
| ---- | ------ |
| Bearer token in `localStorage` | Accepted trade-off (XSS surface); mitigated by edge CSP; no HttpOnly cookies today. |
| Production login path | **Implemented** — password + TOTP MFA + recovery codes, step-up for sensitive MFA actions, durable account+IP lockout, idle timeout and session rotation. |
| SSO / provisioning | Not implemented (future): OIDC id_token validation + state/PKCE, SCIM. Passkeys (WebAuthn register) also future. |
| api ↔ postgres TLS | **Enforced in the default compose** (`sslmode=verify-full` + mounted CA via `scripts/cert-postgres.sh`); local cert is dev-only. |
| In-process rate limiter | Per-instance budget; edge `limit_req` is the global control. Backed by a durable DB lockout per (account, IP). |
| Distributed attack (many IPs) | Account-global soft delay only (no hard lock by email); documented residual risk. |
| Secrets at rest | Implemented (envelope v1); KEK rotation is a documented manual procedure (§6 runbook); pepper rotation via `RECOVERY_PEPPER_PREVIOUS`. |
| Edge rate limit | Implemented via `--profile edge`; without the profile only the app-layer limiter applies. |

## Testing/verification

- TOTP/WebAuthn/OIDC/session primitives covered by unit tests; secret-leakage
  tests (plaintext never at rest, never on the wire, never logged).
- Integration (22 tests): RLS tenant isolation under `llmquota_app`
  (negative cases), envelope round-trip (wrong KEK throws), BOLA across users,
  supervisor RBAC (403 vs 200), session hygiene (expired/revoked → 401).
- Wire-level API tests: CORS single-origin + evil-origin rejection, 401
  without/with bad token, QUERY + GET alias parity, no stack traces in
  `problem()`.
- Aligned to OWASP ASVS Level 2. See
  [testing.md](testing.md) for the full matrix.
