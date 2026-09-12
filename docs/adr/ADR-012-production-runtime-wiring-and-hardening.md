# ADR-012: Production Runtime Wiring and Hardening

**Status:** accepted (final architecture + security + dev review remediation)

## Context

A final review across architecture, security and development found that several
Phase 5–8 components existed only as code or intent, and the shipped topology
did not match the documented security posture:

1. **The collector was never wired.** The scheduler primitives (`scheduleNext`,
   `stagger`) lived in `core` and were unit-tested, but nothing inside the
   running API process invoked them — no snapshots or aggregates were ever
   produced in a deployed stack.
2. **The superuser pool bypassed RLS.** The compose `api` service connected
   with the cluster superuser credentials, so every tenant `FORCE ROW LEVEL
   SECURITY` policy was moot in production — exactly the bypass the test
   harness works hard to avoid (it connects as `llmquota_app` precisely to
   prove RLS).
3. **Contract drift on connections.** Documentation described a `x-secret`
   header transport, while the implemented contract passes the `secret` in the
   JSON body of `POST /v1/connections`; list responses needed a guaranteed
   safe DTO that can never leak `secret_cipher`.
4. **CORS was broken for the SPA.** The browser cannot emit `QUERY`
   (RFC 10008) or many cross-origin calls without an answered `OPTIONS`
   preflight and an explicit allow-methods list; the API neither answered
   preflight correctly nor allow-listed the origins/methods.
5. **The dev session endpoint failed open.** `POST /auth/issue-session` minted
   a session for any `userId` unauthenticated, with a hardcoded
   `SESSION_SECRET` fallback — a total-compromise surface if ever shipped to
   production.

## Decisions

1. **In-process collector scheduler + collector RLS policy.** The API process
   runs the collector on an interval (`COLLECT_INTERVAL_MS`, default `60000`,
   first pass ~5 s after boot, `0` disables). Migration `0002` adds
   `app.is_collector` policies granting the collector a narrow cross-tenant
   `SELECT`/`DELETE` surface for enumeration and eviction; all writes happen
   per owner under the normal `withRlsContext` per-user GUC transaction. A
   collector bug therefore cannot write across tenants.
2. **Non-superuser app-role pool via first-boot provisioning.** The compose
   `api` service connects as `llmquota_app` with `POSTGRES_APP_PASSWORD`.
   Migration `0001` creates the role **without** a password;
   `docker/pg/init-prod.sh` (mounted into `docker-entrypoint-initdb.d`) sets
   it idempotently on an empty data volume. The superuser is reserved for
   migrations/seed, reachable only through the loopback-only `--profile ops`
   port (`127.0.0.1:${POSTGRES_OPS_PORT:-15432}`).
3. **Safe DTO projections.** `GET /v1/connections` returns
   `id, providerKey, label, connectionType, status, createdAt` —
   `secretCipher` is never serialized. `POST /v1/connections` accepts
   `{providerId, label?, connectionType?, secret}` in the JSON body; the
   secret is sealed at rest via envelope encryption (AES-256-GCM, format v1)
   and the plaintext is never echoed. Documentation was corrected to match.
4. **Origin-allow-listed CORS with preflight.** The API allow-lists `WEB_ORIGIN`
   plus the dev ports `localhost:5173` / `localhost:4173`, answers `OPTIONS`
   preflight, and includes `QUERY` in the allow-methods so the SPA's history
   read works (GET alias preserved for simple clients).
5. **Fail-closed dev endpoints.** `POST /auth/issue-session`,
   `GET /auth/oidc/authorize` and `GET /auth/mfa/{totp,webauthn}/challenge`
   require **both** `ENABLE_DEV_SESSION=1` **and** `NODE_ENV` ≠ production;
   otherwise `403 problem+json`. The production compose leaves
   `ENABLE_DEV_SESSION` empty. `issue-session` requires a valid
   `SESSION_SECRET` (≥ 32 chars, no fallback) and caps lifetime at 24 h.
6. **Transport and abuse controls.** When `TLS_CERT_PATH`/`TLS_KEY_PATH` are
   set, the Node listener is TLS **1.3-only** and adds HSTS; the `--profile
   edge` nginx terminates TLS 1.3 (HTTP/3 preferential) with HSTS/CSP headers
   and `limit_req` **10 r/m** on `/auth/`, complementing the in-process
   per-IP **30 req/min** limiter on `/auth/*`. Request bodies are capped at
   **64 KB**.
7. **Session signature verification.** Migration `0002` adds
   `user_sessions.signature` (HMAC-SHA256 over `SESSION_SECRET`); the auth
   middleware verifies it on every request when the secret is configured, so a
   leaked hash table cannot mint valid sessions.
8. **History contract pinned.** `GET /v1/history` and `QUERY /v1/history`
   share one handler; body `{from, to, granularity}` with
   `granularity ∈ {daily, weekly, monthly}`; omitted bounds mean the full
   12-month retained window; errors are RFC 7807; list reads use the cursor
   `has_more` placeholder shape.

## Consequences

- `FORCE ROW LEVEL SECURITY` is finally enforced in the shipped topology; the
  integration suite's `llmquota_app` subject now mirrors production exactly.
- The collector is real: snapshots (7-day TTL) and spending aggregates
  (12-month retention, real usage only) accumulate without any sidecar.
- The SPA works against the API from an allowed origin, including `QUERY`.
- The localStorage bearer-token model is an accepted, documented XSS trade-off
  behind a strict edge CSP — no HttpOnly cookies exist.
- The production **login path remains a known limitation**: OIDC id_token
  validation, server-side state/verifier persistence and MFA verify endpoints
  are specified (ADR-009) but unimplemented; only fail-closed dev endpoints
  exist.
- Operations gain loopback-only levers (ops port bootstrap, `llmquota_app`
  password rotation, KEK rotation concept) — captured in the
  [runbook](../runbook.md).
- Superuser credentials never leave the migrate/seed/backup context; leaked
  API-pool credentials expose at most the RLS-scoped tenant surface.
