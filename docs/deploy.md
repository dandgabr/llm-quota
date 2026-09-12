# Deployment (v1)

Status: **implemented** — engine-agnostic (Docker `compose` or
`podman-compose`); see `docker/compose.yaml`, `apps/api/Dockerfile`,
`apps/web/Dockerfile`, and `docker/backup.sh` / `docker/restore.sh`.
Operational procedures (bootstrap, backup/restore, rotation) live in the
[runbook](runbook.md); the full env-var reference is
[architecture/environment-variables.md](architecture/environment-variables.md).

## Topology

Single-host stack via `docker compose` **or** `podman-compose`. The default
profile is three services; TLS termination and a host-side DB port are
opt-in profiles:

```
[ browser ] ──TLS 1.3/HTTP-3──▶ [ edge ] (profile "edge", ports 80/443)
                                     │ proxy /      ──▶ [ api ]  (Hono + collector)
                                     │ proxy /app/   ──▶ [ web ]  (built SPA, loopback-only)
                                     └──────────────────────┐
[ host ops ] ──127.0.0.1:15432──▶ [ ops ] (profile "ops") ──▶ [ postgres ] (internal network only)
```

| Service    | Image / build            | Exposure                                          | Notes                                                                                         |
| ---------- | ------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `postgres` | `postgres:17-alpine`     | internal network only                             | First boot runs `docker/pg/init-prod.sh`, provisioning the non-superuser `llmquota_app` role.  |
| `api`      | `apps/api/Dockerfile`    | internal network only                             | `DATABASE_URL` connects as **`llmquota_app`** (non-superuser) so `FORCE ROW LEVEL SECURITY` applies. Runs the collector scheduler in-process. |
| `web`      | `apps/web/Dockerfile`    | `127.0.0.1:${WEB_HTTP_PORT:-8080}:80` (loopback)  | nginx serving the built SPA. Browsers reach it through the edge (or an external ingress/tunnel).|
| `edge`     | `nginx:1.27-alpine`      | `80`, `443` (TCP + UDP for HTTP/3)                | **`--profile edge`**. TLS 1.3-only, HTTP/3 preferential, HSTS/CSP headers, `limit_req` on `/auth/`, QUERY allow-listed. Certs from `../certs`. |
| `postgres-ops-port` | `alpine` (socat)| `127.0.0.1:${POSTGRES_OPS_PORT:-15432}`           | **`--profile ops`**. Host-side migrate/seed access. Bring up, bootstrap, then take it down.     |

The API also enforces TLS 1.3-only on its own listener **when**
`TLS_CERT_PATH`/`TLS_KEY_PATH` are set (local testing; production terminates
TLS at the edge).

## Running it

```bash
# Secrets (see docker/.env.example): POSTGRES_PASSWORD, POSTGRES_APP_PASSWORD,
# LLM_QUOTA_KEK, SESSION_SECRET are all required guards.
cp docker/.env.example docker/.env   # then fill every secret

# With Docker
docker compose -f docker/compose.yaml --env-file docker/.env up -d --build
# With Podman
podman-compose -f docker/compose.yaml --env-file docker/.env up -d --build
```

First run only — bootstrap schema + admin through the ops profile (full
procedure in the [runbook](runbook.md#1-first-run-bootstrap-fresh-deployment)):

```bash
docker compose -f docker/compose.yaml --env-file docker/.env --profile ops up -d
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:15432/${POSTGRES_DB}"
pnpm --filter @llm-quota/db db:migrate
SEED_ADMIN_EMAIL=ops@example.com pnpm --filter @llm-quota/db seed
docker compose -f docker/compose.yaml --env-file docker/.env --profile ops down
```

Optional TLS edge (place `fullchain.pem` + `privkey.pem` under `certs/`):

```bash
docker compose -f docker/compose.yaml --env-file docker/.env --profile edge up -d
```

The `api` service boots `apps/api/src/bin.ts` → `server.ts` (`start()`), which
attaches Hono via `@hono/node-server`, serves `GET /health`, `/auth/*` and the
`v1` contract (ADR-008, incl. `QUERY`), applies origin-allow-listed CORS, and
refuses `local.*` certificates in `NODE_ENV=production`.

## Collector configuration

The collector runs inside the `api` process. `COLLECT_INTERVAL_MS`
(default `60000`, first pass ~5 s after boot, `0` disables) is the only knob —
see the [runbook](runbook.md#7-collector-tuning) for behavior and tuning
notes.

## Required configuration

Secrets are supplied via env, never committed (`docker/.env` is git-ignored;
see `docker/.env.example`):

- `POSTGRES_PASSWORD` — superuser (migrations/seed only; **not** the API pool).
- `POSTGRES_APP_PASSWORD` — password for the `llmquota_app` app role
  (provisioned on first boot by `docker/pg/init-prod.sh`).
- `DATABASE_URL` — composed by the file as
  `postgres://llmquota_app:…@postgres:5432/llm_quota`; do not override.
- `LLM_QUOTA_KEK` — base64 32-byte key for envelope encryption
  (`openssl rand -base64 32`).
- `SESSION_SECRET` — session HMAC signer (≥ 32 chars); enables per-request
  signature verification.
- `VITE_API_URL` — build-time API base URL baked into the SPA bundle.
- `ENABLE_DEV_SESSION` — **leave empty in production**; the dev endpoints are
  refused there anyway (fail-closed).

## Hardening (implemented)

- **TLS 1.3-only** at the edge (`docker/nginx/edge.conf`) with HTTP/3 (QUIC)
  preferential (`Alt-Svc`, UDP 443) and graceful `h2 → h1.1` fallback; AEAD
  cipher suites only. HSTS (`max-age=63072000; includeSubDomains`), CSP
  (`default-src 'self'`), `X-Content-Type-Options`, `X-Frame-Options: DENY`.
- **Rate limiting** — nginx `limit_req` **10 r/m** (burst 20) per IP on
  `/auth/`, plus an in-process per-IP **30 req/min** limiter on `/auth/*` at
  the app layer.
- **CORS** — exact origin allow-list (`WEB_ORIGIN` + dev ports), `OPTIONS`
  preflight answered, **QUERY in the allow-methods** (ADR-008).
- **64 KB request body cap** at the API.
- **Sessions** — opaque 256-bit tokens: SHA-256 hash at rest **plus**
  HMAC-SHA256 signature (`user_sessions.signature`) verified on every request
  when `SESSION_SECRET` is set.
- **RLS in the shipped topology** — the API pool is the non-superuser
  `llmquota_app`; tenant `FORCE ROW LEVEL SECURITY` cannot be bypassed. The
  collector enumerates through a dedicated `app.is_collector` policy.
- App-level structured audit logging (ASVS V16 alignment, `auditLogger`).

The `postgres` ↔ `api` link stays on the internal compose network; enforcing
TLS on that hop (`sslmode=verify-full` posture) is a hardening backlog item,
not wired in the shipped compose.

### Certificates

- **Edge profile**: mount a real-CA certificate (e.g. Let's Encrypt via ACME)
  as `certs/fullchain.pem` + `certs/privkey.pem`; `certs/` is git-ignored.
  Automatic ACME renewal is not bundled — renew out-of-band.
- **Local testing only**: self-signed cert via `scripts/cert-local.sh` into
  `certs/` (git-ignored). The API refuses `local.*` certs in
  `NODE_ENV=production`.

## Backup & PITR

- `docker/backup.sh` runs `pg_dump` (logical) into `docker/backups/`
  (git-ignored, umask 077); `docker/restore.sh` restores a dump.
- WAL lives inside the `pgdata` volume with **no off-host archiving** — PITR
  today means volume snapshots; see the
  [runbook](runbook.md#4-point-in-time-recovery-pitr-note).

## Observability

- Structured JSON audit logging (method/path/status/ms) per request.
- Collector health is observable via snapshot freshness
  (`GET /v1/quotas` latest-persisted-per-connection); dedicated metrics are a
  backlog item.
