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
| `ENABLE_DEV_SESSION`  | dev-only `/auth/*` endpoints                  | unset (off)    | no              | `1` enables `POST /auth/issue-session` + OIDC/MFA challenge endpoints — **and only** with `NODE_ENV` ∈ {`development`,`test`}. Fail-closed; removed in Phase D (real login). |
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
