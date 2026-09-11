# Deployment (v1)

Status: plan — implemented in [Phase 7](architecture/implementation-plan.md).

## Topology

Docker Compose on a single host, running four units:

```
[ browser ] ──TLS 1.3──▶ [ web ]    (SPA frontend, Vue 3 + Vite)
                ──TLS 1.3──▶ [ api ]   (backend REST API + collectors)
                              │
                              └──▶ [ postgres ]   (dedicated container)
                                       │
                                       └─ backup / PITR
```

- **web** — statically served SPA; talks only to the API over HTTPS.
- **api** — the only unit with DB access; runs the scheduler and connectors.
- **postgres** — dedicated container, on an isolated Docker network.

## Required configuration

Secrets are supplied via env, never committed:

- `DATABASE_URL` — `postgres://<user>:<pass>@postgres:5432/llm_quota`
- `LLM_QUOTA_KEK` — base64 32-byte key for envelope encryption
  (`openssl rand -base64 32`)
- `SESSION_SECRET` — server-side session signer
- OIDC credentials when identity providers are connected

See `.env.example` at the repo root.

## Hardening (Phase 7)

- TLS 1.2/1.3 termination at the ingress (web/api).
- HTTP security headers: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`.
- Rate limiting on auth and quota-collection endpoints.
- App-level audit logging (ASVS V16 alignment).

## Backup & PITR

- Scheduled logical dump (e.g. daily `pg_dump`) and WAL archive for
  point-in-time recovery.
- Backups stored off-host and restore-tested in the runbook.

## Observability

- Structured application logging.
- Metrics for collector runs, FX cache hits, and endpoint latency
  (Phase 7 scope).
