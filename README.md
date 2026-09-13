# llm-quota

Monitor AI subscription quotas independently of each provider's own metric.
A modular-monolith TypeScript monorepo: a SaaS web frontend + a backend API
with an in-process quota collector, all sharing one PostgreSQL 17 store with
tenant Row-Level Security.

This is the entry point for developers. Detailed technical documentation lives
under [docs/](docs/README.md) (architecture, ADRs, runbook, deploy).

## Highlights

- **Provider-agnostic quota snapshots** — relative % per time window *and*
  monetary credits (total or used/limit), normalized per connection.
- **Multi-provider, multi-connection** — tailored `ProviderConnector`s routed by
  a `ProviderRegistry` (`providerId + connectionType`). Supported connectors:
  **Google Antigravity** (`antigravity/oauth`), **OpenCode Go** (`opencode-go/api`),
  **Ollama Claude** (`ollama-claude/api`), and **OpenRouter** (`openrouter/api`).
- **Immediate sync & event-driven updates** — creating or updating a connection
  triggers an instant collection pass (`triggerCollectorSync`) with an optimistic
  response race, so fresh quotas appear immediately without waiting for the scheduler.
- **Collector** — a scheduler inside the API process polls connections, persists
  raw snapshots (7-day TTL) and spending aggregates (12-month retention); only
  real usage (`used`) is booked, balance-only credits never inflate spend.
- **History API** — daily/weekly/monthly granularity over the last 12 months,
  via `GET /v1/history` and its canonical `QUERY` (RFC 10008) form.
- **Multi-user + RBAC & LGPD compliance** — user / supervisor / admin roles enforced server-side;
  tenant isolation via Postgres `FORCE ROW LEVEL SECURITY` and a non-superuser
  app role (`llmquota_app`) for the API pool. Full LGPD erasure/anonymize flow (`user.purged`).
- **Tamper-evident audit trail** — append-only audit log with serialized SHA-256
  hash chain (`prev_hash`/`event_hash`), monotonic sequencing, automated retention,
  and admin verification (`GET /v1/audit/verify`).
- **Secrets at rest encrypted** — envelope encryption (AES-256-GCM, per-value
  DEK wrapped by a KEK from `LLM_QUOTA_KEK`).
- **Authentication & MFA** — production local authentication with scrypt password hashing,
  mandatory TOTP MFA for privileged roles, one-time recovery codes, durable lockout
  backoff, session rotation with grace window, and step-up verification.
- **SPA** — Vue 3 + Vite + Pinia + vue-router + Chart.js, i18n (en / pt-BR)
  via `@llm-quota/i18n` (i18next, ICU MessageFormat on JSON v4), light/dark
  theme, responsive quota distribution and model-group cards (e.g. Gemini vs Claude/GPT).
- **Honest API contract** — RFC 7807 `problem+json` errors, cursor pagination,
  safe DTO projections (connection secrets never leave the server).

## Architecture

```mermaid
flowchart LR
    B["Browser - Vue 3 SPA"]
    E["Edge nginx - TLS 1.3 + HTTP/3 + rate limit (optional --profile edge)"]
    W["web - built SPA, loopback-only port"]
    A["api - Hono REST + in-process collector scheduler"]
    P[("PostgreSQL 17 - FORCE RLS, app role llmquota_app")]

    B -->|"HTTPS 443"| E
    E --> A
    E --> W
    B -->|"dev: 127.0.0.1"| W
    B -->|"Bearer token, JSON"| A
    A -->|"non-superuser pool"| P
```

The collector runs inside the `api` process: it enumerates connections
cross-tenant through a dedicated `app.is_collector` RLS policy, then writes
snapshots/aggregates per owner under a per-user RLS context. See
[docs/architecture/overview.md](docs/architecture/overview.md) for the module
map and runtime dataflow, and
[docs/adr/ADR-012-production-runtime-wiring-and-hardening.md](docs/adr/ADR-012-production-runtime-wiring-and-hardening.md)
for the wiring decisions.

## Repository layout

```
apps/
  api/         REST API + collector scheduler (Hono on @hono/node-server)
  web/         Vue 3 + Vite SPA
packages/
  shared/      shared TS types, DTOs, env helpers
  core/        domain: quotas, windows, history, FX abstraction, crypto
  auth/        OIDC/TOTP/WebAuthn primitives, session tokens, RBAC
  db/          Drizzle ORM schema, migrations, repositories, seed
  i18n/        i18next runtime + locales (en, pt-BR)
  providers/   connector framework + registry
    connectors/
      antigravity/     @llm-quota/connector-antigravity
      ollama-claude/   @llm-quota/connector-ollama-claude
      opencode-go/     @llm-quota/connector-opencode-go
      openrouter/      @llm-quota/connector-openrouter
docs/
  adr/         architecture decision records
docker/        compose files, pg init scripts, nginx edge, backup scripts
```

## Prerequisites

- **Node.js >= 22**
- **pnpm 12.3.4** via corepack (`packageManager` is pinned in `package.json`)
- **Docker or Podman** (engine-agnostic compose; Podman users run
  `podman-compose`), for PostgreSQL 17 and the shipped stacks
- PostgreSQL 17 comes from the compose files — no local install needed

## Getting started

### A. Local development

```bash
corepack enable
corepack prepare pnpm@12.3.4 --activate
pnpm install

cp .env.example .env
```

Fill `.env` (see [docs/architecture/environment-variables.md](docs/architecture/environment-variables.md)):

```bash
# envelope-encryption key and session signer
printf 'LLM_QUOTA_KEK=%s\n' "$(openssl rand -base64 32)" >> .env
printf 'SESSION_SECRET=%s\n' "$(openssl rand -base64 32)" >> .env
# dev-only session issuance for local login (refused in production)
printf 'ENABLE_DEV_SESSION=1\n' >> .env
```

Start PostgreSQL and point `DATABASE_URL` at it. The test stack (host port
**55432**) doubles as a local dev database:

```bash
podman-compose -f docker/compose.test.yaml up -d     # or: docker compose -f docker/compose.test.yaml up -d
```

```dotenv
DATABASE_URL=postgres://llmquota:llmquota-test@localhost:55432/llm_quota_test
```

Apply migrations and seed (providers + optional bootstrap admin):

```bash
pnpm --filter @llm-quota/db db:migrate
SEED_ADMIN_EMAIL=admin@example.com pnpm --filter @llm-quota/db seed
```

Run both apps:

```bash
pnpm dev
# api  -> http://localhost:3000 (tsx watch src/bin.ts)
# web  -> http://localhost:5173
```

Prefer `db:migrate` over `db:push` — `db:push` diffs the schema directly and
can drift from the versioned migrations.

### B. Tests

```bash
pnpm test                 # unit only, no DB required
```

Integration tests are DB-backed and serialized; they need the test Postgres up:

```bash
podman-compose -f docker/compose.test.yaml up -d    # Postgres 17 on 127.0.0.1:55432
pnpm test:integration
```

Playwright E2E runs fully self-contained (own API stub on `127.0.0.1:3100` +
vite preview on `4173`; no database needed):

```bash
pnpm --filter @llm-quota/web exec playwright install chromium   # once
pnpm --filter @llm-quota/web exec playwright test
```

Current status: unit — 18 turbo tasks green; integration — 22 tests
(10 DB + 12 API over the wire); Playwright — 28/28.

### C. Production (compose + profiles)

```bash
cp docker/.env.example docker/.env    # then fill every required secret
```

```bash
docker compose -f docker/compose.yaml --env-file docker/.env up -d --build
# podman equivalent:
podman-compose -f docker/compose.yaml --env-file docker/.env up -d --build
```

Profiles:

| Profile            | Adds                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| *(default)*        | `postgres` (internal only) + `api` (connects as `llmquota_app`) + `web` (loopback `127.0.0.1:${WEB_HTTP_PORT:-8080}`) |
| `--profile edge`   | nginx TLS 1.3 + HTTP/3 edge on ports 80/443 (certs from `../certs`, rate limit on `/auth/`) |
| `--profile ops`    | loopback-only Postgres port (`127.0.0.1:${POSTGRES_OPS_PORT:-15432}`) for host-side migrate/seed |

First run only — bootstrap the schema and the admin user through the ops port:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env --profile ops up -d
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:15432/${POSTGRES_DB}"
pnpm --filter @llm-quota/db db:migrate
SEED_ADMIN_EMAIL=ops@example.com pnpm --filter @llm-quota/db seed
docker compose -f docker/compose.yaml --env-file docker/.env --profile ops down
```

Optionally bring up the TLS edge:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env --profile edge up -d
```

See [docs/deploy.md](docs/deploy.md) for the full topology and
[docs/runbook.md](docs/runbook.md) for backup/restore, rotation and collector
operations.

### D. First login & Onboarding

1. **Setup wizard**: When the database is newly initialized without administrators, navigating to `http://localhost:3000` (or `http://localhost:5173`) redirects to `/setup`.
2. **First Administrator Bootstrap**: The server generates an ephemeral setup token at first boot (printed to the server log). Entering the token in the `/setup` wizard allows provisioning the primary administrator account, password, and enrolling mandatory TOTP MFA.
3. **Invites & Local Login**: Administrators can invite other users (`/admin`), and users authenticate directly via `POST /auth/login` (with TOTP challenge if enrolled).

## Verification checklist

```bash
pnpm lint        # eslint across workspaces
pnpm typecheck   # tsc --noEmit across workspaces
pnpm test        # unit suites, no DB
pnpm build       # turbo build, all packages
```

Integration + E2E follow section B. All four commands above are expected green
on a clean checkout.

## Known limitations & Backlog

- **SSO / External OIDC** — OIDC authorization primitives exist in `packages/auth`, but enterprise identity provider login federation (e.g. Okta, Azure AD, Google Workspace SSO) and SCIM provisioning are scheduled for future phases; local password + TOTP MFA is the active production auth path.
- **Bearer token in `localStorage`** — documented XSS trade-off, mitigated by a
  `default-src 'self'` CSP at the edge. There are no HttpOnly cookies today.
- **FX HTTP fetcher unwired** — the currency engine accepts an injected rate
  source; `FX_API_BASE` / `FX_API_KEY` are reserved, currently unread.

## Documentation

- [Docs index](docs/README.md)
- [Architecture overview](docs/architecture/overview.md)
- [Security design](docs/architecture/security.md)
- [Testing strategy](docs/architecture/testing.md)
- [Environment variables](docs/architecture/environment-variables.md)
- [Deploy](docs/deploy.md) · [Runbook](docs/runbook.md)
- [ADRs](docs/adr/README.md)

## License

[MIT](LICENSE)
