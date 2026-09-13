# Architecture Overview

Status: implemented through Phase 8 plus the production-wiring hardening pass
([ADR-012](adr/ADR-012-production-runtime-wiring-and-hardening.md)); this page
stays in sync with the code.

## Principles

- **Modular monolith (v1)** — one deployable server with clear module
  boundaries (`core`, `providers`, `auth`, `users`, `i18n`) that communicate via
  typed function/domain interfaces, not network calls. Microservices are
  deferred to a future v2 only if real pressure emerges. See
  [ADR-001](adr/ADR-001-modular-monolith-connectors-crypto-oidc.md).
- **Client/server** — every client (the web SaaS today; future desktop, gadget,
  GNOME extension, CLI) consumes the same backend API. The frontend is just one
  consumer; no business rules live in the client.
- **Decoupled, separately editable systems** — frontend, core, provider
  management and user management are separate packages so they can evolve and be
  tested independently.
- **Connector pattern + registry** — each provider implements a
  `ProviderConnector` interface; a `ProviderRegistry` (the provider-management
  integrator) routes reads by `providerId + connectionType`. A provider may have
  several connection types registered as separate connectors (OAuth vs API).
  See [ADR-007](adr/ADR-007-connector-framework-snapshot-http.md) for the raw
  snapshot + injectable HTTP design.
- **OIDC-standard auth** — identity is abstracted behind OIDC so Google / GitHub /
  Discord / SSO federation can be added without rework. The primitives exist;
  the production login wiring is a known limitation (see
  [security.md](security.md)).
- **English** — code, docs and git history are in English.

## Monorepo module map

```
apps/
  api/   REST API + in-process collector scheduler, auth endpoints, RBAC middleware
  web/   Vue 3 + Vite + Pinia SPA (a client of the API)
packages/
  core/        pure domain: quota windows, %, monetary credits, FX abstraction, crypto
  providers/   connector contract + ProviderRegistry (framework)
    connectors/
      antigravity/     @llm-quota/connector-antigravity
      ollama-claude/   @llm-quota/connector-ollama-claude
      opencode-go/     @llm-quota/connector-opencode-go
      openrouter/      @llm-quota/connector-openrouter
  auth/        OIDC/TOTP/WebAuthn primitives, session tokens, RBAC helpers
  i18n/        i18next runtime + locale files (en, pt-BR)
  db/          PostgreSQL schema, migrations, repositories, seed (Drizzle ORM)
  shared/      shared TS types, DTOs, env helpers
```

## Runtime dataflow

The collector is **not** a separate service: a scheduler inside the `api`
process (first pass ~5 s after boot, then every `COLLECT_INTERVAL_MS`,
default 60 s; `0` disables) coupled with an event-driven trigger
(`triggerCollectorSync` on connection create/edit) drives the whole pipeline:

```
[providers (Antigravity, OpenCode Go, Ollama Claude, OpenRouter)]
      │ connector read (injectable HttpClient; OAuth PKCE or API Key)
      ▼
[collector scheduler & triggerCollectorSync, inside api]
      │ enumerate connections cross-tenant via app.is_collector RLS policy
      │ write per-owner under withRlsContext
      ▼
[postgres: quota_snapshots (raw, 7-day TTL)
           spending_aggregates (12-month retention,
                                only real usage `used` booked)]
      │
      ▼
[REST API (Hono): GET /v1/quotas (latest snapshot per connection)
                  GET /v1/quotas/summary (supervisor+, month-to-date by currency)
                  GET | QUERY /v1/history (daily|weekly|monthly, 12-month window)]
      │
      ▼
[Vue 3 SPA: dashboard (Chart.js + model groups), connections, history, admin]
```

Retention bounds storage: raw snapshots expire after **7 days**; only the
aggregates survive for the **12-month** history window. Balance-only credit
snapshots never book spend — aggregates count real usage only.

## Two distinct "session" entities

Per [ADR-003](adr/ADR-003-confirmed-scope.md) these are modeled separately:

1. **User session** — an authenticated login: an opaque 256-bit bearer token
   (hashed + HMAC-signed at rest, held in the SPA's `localStorage`); its
   lifecycle defines user-session rollup boundaries.
2. **Quota/work session** — returned by quota APIs: % of usage remaining and time
   remaining until reset. It is a provider domain entity, unrelated to login.

## History & retention

- The collector persists raw snapshots and aggregates them by session cycle:
  **daily**, then rolled up to **weekly** and **monthly**.
- Raw `quota_snapshots` are kept **7 days**; `spending_aggregates` are retained
  for the **last 12 months** and evicted beyond that.
- History reads serve daily/weekly/monthly granularity over that retained
  window (`GET /v1/history` and its canonical `QUERY` form; omitted bounds =
  full 12-month window).

## Security posture

- Secrets (API keys, OAuth refresh tokens) are encrypted at rest with
  **envelope encryption** (AES-256-GCM: a per-value DEK, KEK from env/KMS).
- OAuth **access** tokens live in memory/encrypted cache; refresh tokens persist
  encrypted in the DB (`connections.secret_cipher`, never serialized to DTOs).
- RBAC enforced server-side at the object level (BOLA protection);
  supervisor = own providers + read-only view of others' spend.
- Tenant isolation via `FORCE ROW LEVEL SECURITY` with a **non-superuser** app
  role for the API pool; per-request GUCs (`app.user_id`, …) plus an
  `app.is_collector` policy for the collector.
- Sessions: opaque 256-bit bearer tokens (SHA-256 hash + HMAC-SHA256 signature
  at rest) kept in `localStorage` — an accepted XSS trade-off behind a strict
  edge CSP. All `/auth/*` issuance endpoints are dev-only and fail closed.

See [ADR-001](adr/ADR-001-modular-monolith-connectors-crypto-oidc.md),
[ADR-012](adr/ADR-012-production-runtime-wiring-and-hardening.md) and
[docs/architecture/security.md](security.md) for detail.

## Cross-cutting concerns

- **Currency**: `core` defines a `CurrencyRateSource` abstraction with a
  DB-backed cache (`fx_rates`); the FX HTTP fetcher is **not wired** —
  `FX_API_BASE` / `FX_API_KEY` are reserved, currently unread. Display
  formatting uses `Intl.NumberFormat` with the user's locale.
- **i18n**: i18next runtime (`@llm-quota/i18n`) with ICU MessageFormat on
  JSON v4 locale files, `en` canonical, `pt-BR` fallback. See
  [ADR-002](adr/ADR-002-i18n-format.md).
- **Testing**: unit (Vitest) per package, integration against a real Postgres
  (RLS, migrations, collector), API-over-the-wire E2E, Playwright usability at
  the app level, plus connector contract tests. See
  [docs/architecture/testing.md](testing.md).
- **Code documentation**: TSDoc for every public surface, English, with module
  headers. See [docs/architecture/code-documentation-conventions.md](code-documentation-conventions.md)
  and [ADR-006](adr/ADR-006-code-documentation-standard.md).
- **API & transport**: REST verb set incl. **QUERY** (RFC 10008) under
  OpenAPI 3.2; **TLS 1.3-only** Node listener when certs are set; TLS 1.3 +
  HTTP/3 at the edge profile. See
  [api-conventions](api-conventions.md) and [ADR-008](adr/ADR-008-rest-api-tls-quic-query.md).
- **Web frontend**: Vue 3 + Vite + Pinia + vue-router SPA consuming the API via a
  typed client; i18n en/pt-BR, Chart.js history, `Intl` currency, auth guard.
  See [implementation-plan](implementation-plan.md).

## Deploy (v1)

Docker Compose (or podman-compose): postgres (internal) + api (app-role pool)
+ web (loopback); optional `edge` profile (TLS 1.3 + HTTP/3, rate limiting)
and `ops` profile (loopback DB port for migrate/seed); backups via pg_dump.
See [docs/deploy.md](../deploy.md) and the [runbook](../runbook.md).
