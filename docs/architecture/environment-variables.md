# Environment Variables Reference

One table per consumption context. Sources of truth: `.env.example` (local
dev), `docker/.env.example` (compose stack), `docker/compose.yaml`
(interpolation), `packages/db/src/client.ts` (the only reader of
`DATABASE_URL` / `PG_MAX_CONNECTIONS` in application code).

Required-ness legend: **required** = the process fails or refuses to start
without it; *recommended* = safe default but wrong for real deployments.

## API runtime (`apps/api`, also `packages/db` client)

| Variable              | Consumed by                                   | Default        | Required?       | Notes                                                                                                         |
| --------------------- | --------------------------------------------- | -------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | server guards (dev endpoints, local TLS certs)| `development`  | *recommended*   | `production` refuses dev session endpoints and `local.*` certificates, regardless of other flags.              |
| `PORT`                | Hono listener                                 | `3000`         | no              | Compose pins the in-container value to `3000`.                                                                |
| `DATABASE_URL`        | `resolveDatabaseConfig` (db pool)             | —              | **required**    | Compose builds it as `postgres://llmquota_app:…@postgres:5432/…` — the **non-superuser** app role (FORCE RLS). |
| `PG_MAX_CONNECTIONS`  | pool `max`                                    | `10`           | no              |                                                                                                               |
| `LLM_QUOTA_KEK`       | envelope encryption (`packages/core/crypto`)  | —              | **required**    | Base64, 32 bytes: `openssl rand -base64 32`. Never stored in the DB; rotating it is a procedure (runbook §6).  |
| `SESSION_SECRET`      | session HMAC signature + dev issuance         | —              | **required**    | ≥ 32 chars. When set, the stored session signature is verified on every request (defense-in-depth).            |
| `ENABLE_DEV_SESSION`  | dev-only `/auth/*` endpoints                  | unset (off)    | no              | Retained only for the dev OIDC/WebAuthn challenge stubs; real login replaces token paste. Refused outside `development`/`test`. |
| `TOTP_ISSUER`         | TOTP enrollment `otpauth://` issuer           | `llm-quota`    | no              | Shown in the authenticator app when enrolling MFA.                                                             |
| `AUTH_PEPPER`         | login-throttle key HMAC                        | —              | **required (prod)** | ≥32 chars. HMACs the email/IP into `auth_login_attempts` (never plaintext). Fail-closed in production.      |
| `RECOVERY_PEPPER`     | MFA recovery-code HMAC                         | —              | **required**    | ≥32 chars, distinct from `AUTH_PEPPER`. Without it, recovery is disabled (500), never an unpeppered fallback.  |
| `RECOVERY_PEPPER_PREVIOUS` | recovery-code pepper rotation             | unset          | no              | Accepted during pepper rotation (H3). Re-hashes consumed codes with current pepper.                           |
| `SESSION_IDLE_TTL_SECONDS` | idle session timeout                      | `1800`         | no              | `0` disables idle (absolute expiry still applies).                                                             |
| `SESSION_ROTATE_SECONDS` | periodic session rotation                    | `21600`        | no              | Rotates bearer token after N seconds (0 disables).                                                            |
| `SESSION_ROTATE_GRACE_SECONDS` | rotation grace period                 | `60`           | no              | Window during which the previous token remains accepted for in-flight requests.                               |
| `STEP_UP_TTL_SECONDS` | step-up reauth window                          | `300`          | no              | Window after a password/MFA login for MFA enroll/disable without re-asking. `0` = always ask.                  |
| `LOCKOUT_ENABLED`     | durable login throttle                         | `1`            | no              | `0` disables the durable account+IP lockout (in-memory IP rate limit remains).                                 |
| `LOCKOUT_IP_THRESHOLD`| failures before lock                           | `5`            | no              | Scoped to (subject, IP).                                                                                        |
| `LOCKOUT_WINDOW_SECONDS` | failure window                              | `900`          | no              |                                                                                                                 |
| `LOCKOUT_BASE_SECONDS`| backoff base                                   | `30`           | no              | `base * 2^(n-threshold)`, capped.                                                                               |
| `LOCKOUT_MAX_SECONDS` | backoff cap                                    | `3600`         | no              |                                                                                                                 |
| `LOCKOUT_ACCOUNT_THRESHOLD` | account-global failure threshold         | `50`           | no              | Distributed attack detection threshold.                                                                        |
| `LOCKOUT_ACCOUNT_DELAY_MS` | account-global progressive delay           | `1500`         | no              | Added delay per request when threshold is met (0 disables).                                                    |
| `LOCKOUT_ACCOUNT_DELAY_MAX_MS` | max delay cap                          | `5000`         | no              |                                                                                                                 |
| `LOGIN_ATTEMPT_TTL_SECONDS` | throttle sweep TTL                       | `86400`        | no              |                                                                                                                 |
| `SESSION_RETENTION_SECONDS` | rotated/expired session sweep TTL        | `604800`       | no              |                                                                                                                 |
| `AUDIT_RETENTION_DAYS`| audit trail retention sweep                    | `365`          | no              | Swept by collector via `app_audit_sweep()` (min floor 30). 0 disables. Re-anchors genesis.                    |
| `ANTIGRAVITY_CLIENT_ID` | Antigravity OAuth default client ID          | unset          | no              | Corporate or default Google OAuth Client ID for Antigravity connector.                                       |
| `ANTIGRAVITY_CLIENT_SECRET` | Antigravity OAuth default client secret  | unset          | no              | Google OAuth Client Secret for Antigravity connector.                                                        |
| `ANTIGRAVITY_REDIRECT_URI` | Antigravity OAuth redirect URI            | unset          | no              | OAuth 2.0 redirect URI for Antigravity callback.                                                              |
| `WEB_ORIGIN`          | CORS allow-list                               | —              | *recommended*   | Exact origin allow-list; `localhost:5173` / `localhost:4173` dev ports are always allowed.                     |
| `WEB_DIST_PATH`       | SPA static serving (same-origin)              | unset          | no              | Absolute path to the built web app (`apps/web/dist`). When set, the API serves the SPA and returns `index.html` for unknown non-API GET routes. Validated at boot; realpath-confined. |
| `PUBLIC_WEB_URL`      | invite link base                              | same-origin    | no              | Base URL used to build invite links (`${PUBLIC_WEB_URL}/invite#token=…`). Falls back to a relative link.        |
| `TRUST_PROXY`         | client IP resolution for rate limiting        | unset (off)    | no              | `1` honours `X-Forwarded-For`/`X-Real-IP` (only behind a trusted reverse proxy). Never trust these headers otherwise. |
| `COLLECT_INTERVAL_MS` | collector scheduler (in-process)              | `60000`        | no              | First pass ~5 s after boot. `0` disables the scheduler. Also sweeps expired idempotency keys.                  |
| `TLS_CERT_PATH`       | Node listener                                 | unset (HTTP)   | no              | When both TLS vars are set the listener is **TLS 1.3-only** and adds HSTS. Local test certs only (`scripts/cert-local.sh`); production terminates TLS at the edge. |
| `TLS_KEY_PATH`        | Node listener                                 | unset (HTTP)   | no              | See `TLS_CERT_PATH`.                                                                                          |

## Web / build-time (`apps/web`)

| Variable       | Consumed by        | Default             | Required?     | Notes                                                                                   |
| -------------- | ------------------ | ------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `VITE_API_URL` | Vite **build**     | `https://localhost` (compose build arg) | *recommended* | Baked into the SPA bundle at build time — changing it requires rebuilding the `web` image, not a restart. Playwright uses `127.0.0.1:3100` against its own stub. |

## Compose (`docker/.env`, consumed by `docker/compose.yaml`)

| Variable                 | Consumed by                          | Default     | Required?    | Notes                                                                                          |
| ------------------------ | ------------------------------------ | ----------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`          | postgres container (superuser)       | `llmquota`  | no           | Reserved for migrations/seed — **never** the API pool identity.                                 |
| `POSTGRES_PASSWORD`      | postgres container                   | —           | **required** | Compose refuses to start without it (`:?` guard).                                               |
| `POSTGRES_DB`            | postgres container                   | `llm_quota` | no           |                                                                                                 |
| `POSTGRES_APP_PASSWORD`  | `docker/pg/init-prod.sh`             | —           | **required** | Password for the non-superuser `llmquota_app` role; provisioned on first boot (empty volume only). Rotate manually afterwards (runbook §5). |
| `WEB_HTTP_PORT`          | `web` ports mapping                  | `8080`      | no           | Loopback-only: `127.0.0.1:<port>:80`. Browsers reach the SPA through the edge or a tunnel.      |
| `POSTGRES_OPS_PORT`      | `--profile ops` ports mapping        | `15432`     | no           | Loopback-only Postgres port for host-side migrate/seed. Close the profile when done.            |

The compose `api` service also passes through the API-runtime variables above
(`NODE_ENV`, `WEB_ORIGIN`, `COLLECT_INTERVAL_MS`, `PG_MAX_CONNECTIONS`,
`LLM_QUOTA_KEK`, `SESSION_SECRET`, `ENABLE_DEV_SESSION`, `TLS_CERT_PATH`,
`TLS_KEY_PATH`). `DATABASE_URL` is composed inside the file and must not be
overridden.

## Seed (`packages/db` `seed` script)

| Variable           | Consumed by       | Default  | Required? | Notes                                                                    |
| ------------------ | ----------------- | -------- | --------- | -------------------------------------------------------------------------- |
| `SEED_ADMIN_EMAIL` | `src/seed.ts`     | —        | no        | When set, creates an active bootstrap user with this email (idempotent).   |
| `SEED_ADMIN_ROLE`  | `src/seed.ts`     | `admin`  | no        | One of `user` / `supervisor` / `admin`.                                    |

The seed also registers the v1 quota providers regardless of these flags.

## Reserved — NOT wired (do not rely on these)

| Variable             | Intended for                        | Status                                                                                                        |
| -------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `OIDC_ISSUER_URL`    | OIDC identity provider              | **Unwired.** The authorization-challenge endpoint is dev-gated until server-side state/verifier persistence ships; these vars are placeholders. |
| `OIDC_CLIENT_ID`     | OIDC identity provider              | Unwired (see above).                                                                                           |
| `OIDC_CLIENT_SECRET` | OIDC identity provider              | Unwired (see above).                                                                                           |
| `OIDC_REDIRECT_URL`  | OIDC identity provider              | Unwired (see above).                                                                                           |
| `FX_API_BASE`        | external FX rate fetcher            | **Unwired.** The FX engine accepts an injected `CurrencyRateSource`; no HTTP fetcher is bundled, so these are currently unread. |
| `FX_API_KEY`         | external FX rate fetcher            | Unwired (see above).                                                                                           |

## Notes

- The `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_USER` / `POSTGRES_PASSWORD`
  / `POSTGRES_DB` entries in the root `.env.example` are provisioning
  conveniences for composing `DATABASE_URL` by hand. Application code reads
  **only** `DATABASE_URL` (and `PG_MAX_CONNECTIONS`); `resolveDatabaseConfig`
  throws when `DATABASE_URL` is missing.
- Secrets are supplied via env, never committed: `docker/.env` is git-ignored.
