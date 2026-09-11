# Architecture Overview

Status: draft — grows with implementation.

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
- **OIDC-standard auth** — identity is abstracted behind OIDC so Google / GitHub /
  Discord / SSO federation can be added without rework. Local identity, TOTP and
  WebAuthn sit beneath the same facade.
- **English** — code, docs and git history are in English.

## Monorepo module map

```
apps/
  api/   REST API, collectors, auth endpoints, RBAC middleware
  web/   Vue 3 + Vite + Pinia SPA (a client of the API)
packages/
  core/        pure domain: quota windows, %, monetary credits, FX, retention policy
  providers/   connector contract + ProviderRegistry
  connectors/  concrete connectors (ollama-claude, openrouter) -> depends on providers
  auth/        OIDC abstraction, TOTP, WebAuthn, RBAC helpers
  i18n/        i18next runtime + locale files (en, pt-BR)
  db/          PostgreSQL schema, migrations, repositories (Drizzle/Prisma TBD)
  shared/      shared TS types, DTOs, env helpers
```

## Two distinct "session" entities

Per [ADR-003](adr/ADR-003-confirmed-scope.md) these are modeled separately:

1. **User session** — an authenticated login (HttpOnly/Secure session); its
   lifecycle defines user-session rollup boundaries.
2. **Quota/work session** — returned by quota APIs: % of usage remaining and time
   remaining until reset. It is a provider domain entity, unrelated to login.

## History & retention

- Raw snapshots are aggregated by session cycle: **daily**, then rolled up to
  **weekly** and **monthly**.
- Only **aggregates** are retained (no raw detail) to bound storage; retention is
  hard-capped at the **last 12 months**.
- Daily FX rates are cached (daily refresh) to avoid churn.

## Security posture

- Secrets (API keys, OAuth refresh tokens) are encrypted at rest with
  **envelope encryption** (AES-256-GCM: a per-value DEK, KEK from env/KMS).
- OAuth access tokens live in memory/encrypted cache; refresh tokens persist
  encrypted in the DB.
- RBAC enforced server-side at the object level (BOLA protection);
  supervisor = own providers + read-only view of others' spend.
- MFA: TOTP + WebAuthn. Sessions via HttpOnly/SameSite secure cookies.

See [ADR-001](adr/ADR-001-modular-monolith-connectors-crypto-oidc.md) and
[docs/architecture/security.md](security.md) for detail as it is written.

## Cross-cutting concerns

- **Currency conversion**: `core` FX service consumes exchangerate.host (free),
  daily cache, formatted via `Intl.NumberFormat` with the user's locale.
- **i18n**: ICU MessageFormat on JSON v4 (i18next), `en` canonical, `pt-BR`
  fallback. See [ADR-002](adr/ADR-002-i18n-format.md).
- **Testing**: unit (Vitest) per package, integration + E2E (Playwright) at the
  app level, plus connector contract tests. See
  [docs/architecture/testing.md](testing.md).
- **Code documentation**: TSDoc for every public surface, English, with module
  headers. See [docs/architecture/code-documentation-conventions.md](code-documentation-conventions.md)
  and [ADR-006](adr/ADR-006-code-documentation-standard.md).

## Deploy (v1)

Docker Compose: api + web + a dedicated Postgres container; TLS 1.3, backups and
PITR. See [docs/deploy.md](deploy.md).
