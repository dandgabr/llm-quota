# Deployment (v1)

Status: **Phase 7 complete** — engine-agnostic (Docker or Podman); see
`docker/compose.yaml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, and
`docker/backup.sh` / `docker/restore.sh`.

## Topology

Containerized single-host stack via `docker compose` **or** `podman-compose`
(the compose + Dockerfiles are engine-agnostic):

```
[ browser ] ──TLS 1.3/HTTP-3──▶ [ edge/nginx ] ──▶ [ web ]  (SPA + proxy /v1)
                                          └──▶ [ api ]  (Hono + collectors)
                                                    │
                                                    └──▶ [ postgres ] (dedicated, TLS 1.3-only)
```

- **web** — nginx serving the built SPA and proxying `/v1` to `api`.
- **api** — Node 22 Hono REST API + collector; the only unit with DB access.
- **postgres** — dedicated container on an isolated network, **Postgres TLS
  1.3-only** (native wire protocol over TCP — no HTTP/3 on this link).

## Running it

```bash
# Secrets (see docker/.env.example)
cp docker/.env.example docker/.env   # then fill POSTGRES_PASSWORD, LLM_QUOTA_KEK, SESSION_SECRET

# With Docker
docker compose -f docker/compose.yaml up --build
# With Podman
podman-compose -f docker/compose.yaml up --build
```

- API exposes `GET /health`, `/auth/*` (OIDC/TOTP/WebAuthn challenges) and the
  `v1` REST contract (ADR-008, incl. `QUERY`).
- The compose `api` service boots `apps/api/src/bin.ts` → `server.ts` (`start()`),
  which attaches Hono to http/https, enforces TLS 1.3 when certs are set, adds
  restricted CORS + a structured audit log, and refuses `local.*` certs in
  production.

## Required configuration

Secrets are supplied via env, never committed (see `docker/.env.example` /
`.env.example`):

- `DATABASE_URL` — `postgres://<user>:<pass>@postgres:5432/llm_quota` (set via
  compose from `POSTGRES_*`).
- `LLM_QUOTA_KEK` — base64 32-byte key for envelope encryption
  (`openssl rand -base64 32`).
- `SESSION_SECRET` — server-side session signer (≥ 32 chars).
- OIDC credentials when identity providers are connected.

## Hardening (Phase 7)

- **TLS 1.3 (only)** termination at the edge/nginx (`docker/nginx/edge.conf`);
  **HTTP/3 (QUIC) preferential** when supported (UDP 443 + ALPN `h3`), with
  automatic `h2 → h1.1` fallback. The edge **allow-lists the QUERY method**
  (ADR-008). TLS 1.2 accepted for a transition window.
- Postgres accepts TLS 1.3-only and the app connects with `sslmode=verify-full` +
  `sslrootcert`.
- HTTP security headers: CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`.
- Rate limiting on auth and quota-collection endpoints (reinforced at the edge).
- App-level structured audit logging (ASVS V16 alignment, `auditLogger`).

### Certificates

- **Production**: real-CA certificate (e.g. Let's Encrypt via ACME) mounted at
  `docker/nginx/tls/fullchain.pem` + `privkey.pem`; automatic renewal.
- **Local testing only**: self-signed cert via `scripts/cert-local.sh` into
  `certs/` (git-ignored). The API refuses `local.*` certs in
  `NODE_ENV=production`.

## Backup & PITR

- `docker/backup.sh` runs `pg_dump` (logical) into `docker/backups/` (git-ignored).
- `docker/restore.sh` restores a dump. For point-in-time recovery, base the
  restore on the WAL-archived `pgdata` volume (base backup + WAL) — documented
  in the runbook.
- Backups stored off-host and restore-tested in the runbook (Phase 8 covers this
  against a live Postgres).

## Observability

- Structured JSON audit logging (method/path/status/ms) per request.
- Planned metrics for collector runs, FX cache hits, and endpoint latency
  (Phase 8 / runbook).
