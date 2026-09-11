# Security design

Status: design — implementation lands in [Phase 4](architecture/implementation-plan.md).

## Transport security (TLS 1.3 + HTTP/3)

- **Edge (browser ↔ web/api)**: TLS 1.3 mandatory; HTTP/2 + HTTP/3 (QUIC)
  supported, HTTP/3 preferential with automatic `h2 → h1.1` fallback. TLS 1.2
  deprecated after a transition window. See
  [ADR-008](adr/ADR-008-rest-api-tls-quic-query.md) and
  [api-conventions](api-conventions.md).
- **Internal DB (api ↔ postgres)**: Postgres TLS 1.3-only
  (`ssl_min_protocol_version = TLSv1.3`) over its native wire protocol; no
  HTTP/3. Client uses `sslmode=verify-full` + `sslrootcert`.
- **Cipher suites (TLS 1.3, AEAD-only)**: `TLS_AES_256_GCM_SHA384`,
  `TLS_AES_128_GCM_SHA256`, `TLS_CHACHA20_POLY1305_SHA256`.
- **QUERY method**: safe + idempotent body-based reads use QUERY (RFC 10008)
  under OpenAPI 3.2, reducing the CSRF surface vs POST-for-read. The SPA uses a
  GET alias; the ingress must allow QUERY. See [api-conventions](api-conventions.md).
- **Certificates**: production uses real-CA certificates with ACME renewal;
  local testing uses a git-ignored self-signed cert (`scripts/cert-local.sh`),
  refused in `NODE_ENV=production`.

## Envelope encryption (secrets at rest)

All secrets — API keys and OAuth refresh tokens — are encrypted at rest:

- A fresh random **DEK** (data encryption key) is generated per secret value.
- The payload is encrypted with **AES-256-GCM** (authenticated).
- The DEK is wrapped by a **KEK** (key-encryption key) taken from environment or
  a KMS; the KEK is **never** stored in the database.
- The DB stores only ciphertext + the wrapped DEK + metadata.

OAuth **access** tokens are kept in memory/encrypted cache; only **refresh**
tokens persist (encrypted) in the DB.

## Authentication & MFA

- **OIDC-standard** identity abstraction (local + future Google/GitHub/Discord/SSO).
- **TOTP** and **WebAuthn** (passkeys / security keys) as second factors;
  WebAuthn credentials are managed by the user's authenticator/password manager
  (e.g. Bitwarden).
- Sessions use **HttpOnly / SameSite** secure cookies or equivalent secure
  token transport. `SESSION_SECRET` signs the server session.
- OIDC flows validate `state`, use **PKCE**, and pin the `redirect_uri`.

## RBAC & object-level security

Profiles: `user`, `supervisor`, `admin`.

- `admin` — everything a user can do, plus user management and identity-provider
  administration.
- `supervisor` — manages **own** providers/connections **and has a read-only
  view** of other users' spend/quota (no modification of third-party data).
- `user` — connects providers and views own quotas/history.

Access control is enforced server-side at the object level (OWASP BOLA / IDOR
mitigation), not just by route.

## Row-Level Security (tenant isolation)

Applied in Phase 2/3 via versioned migrations (`packages/db/drizzle/0001_*.sql`
with `GRANT`/`ALTER DEFAULT PRIVILEGES` and `FORCE ROW LEVEL SECURITY`). Tenant
tables (users, connections, quota_sessions, quota_snapshots, spending_aggregates,
user_sessions, totp_secrets, webauthn_credentials) are RLS-enabled, FORCE-locked
and restricted to the owning `user_id`. The app role (`llmquota_app`) connects
the pool; the auth middleware (Phase 4/5) sets `app.user_id`,
`app.is_admin` and `app.is_supervisor_admin` via `SET LOCAL` inside each managed
transaction, so policies scope reads/writes per tenant and preserve the
supervisor/admin read paths. Reference/shared data (quota_providers,
identity_providers, fx_rates) is not
tenant-scoped by design.

## Testing/verification

- TOTP/WebAuthn flows covered by automated tests.
- Secret-leakage oriented tests (keys never in plaintext at rest and never
  logged).
- Aligned to OWASP ASVS Level 2; security review in Phase 4.
- RLS policies verified with a dedicated app role (isolated tenant rows).
