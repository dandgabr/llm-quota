# llm-quota

Monitor AI subscription quotas independently of each provider's own metric.
A modular-monolith TypeScript monorepo: a SaaS web frontend + a backend API
+ tailored provider connectors, all sharing one PostgreSQL store.

This is the living entry point. It grows with each implementation phase; see
[docs/README.md](docs/README.md) for the index of technical documentation.

## Highlights

- **Provider-agnostic quotas** — tracks relative % per time window (session,
  daily, weekly, monthly) *and* monetary credits (total USD, or used/limit USD).
- **Multi-provider, multi-connection** — tailored `ProviderConnector`s wired into
  a `ProviderRegistry`. A provider can expose several connection *types*
  (e.g. OpenAI/Codex via OAuth *and* via API). Connections carry user labels
  with label autodetection. v1 connectors: **Ollama Claude** and **OpenRouter**.
- **Currency conversion** — costs in a foreign currency (e.g. USD) are converted
  to the user's locale currency via `Intl` + a daily-cached FX rate.
- **12-month local history** — aggregated by session cycle (daily → weekly →
  monthly), retaining only aggregates to bound storage.
- **Multi-user + RBAC** — user / supervisor / admin profiles; TOTP and WebAuthn
  second factors.
- **OIDC-standard auth** — local identity via an OIDC provider abstraction so
  Google, GitHub, Discord or SSO federation can be added later.
- **Secrets at rest encrypted** — envelope encryption (AES-256-GCM, DEK/KEK).

## Repository layout

```
apps/
  api/         backend server (REST API + collectors)
  web/         SaaS web frontend (Vue 3 + Vite)   [in progress]
packages/
  core/        domain: quotas, windows, history, currency
  providers/   connector framework + registry/integrator
  connectors/  concrete connectors (ollama-claude, openrouter)
  auth/        OIDC abstraction, TOTP, WebAuthn, RBAC
  i18n/        i18next runtime + locales (en, pt-BR)
  db/          PostgreSQL schema, migrations, repositories
  shared/      shared TS types, DTOs, env
docs/
  adr/         architecture decision records
docker/        compose + env + TLS + backup
```

## Prerequisites

- Node.js >= 22
- pnpm >= 10
- PostgreSQL >= 16 (or run the docker-compose stack from Phase 7)

## Getting started

```bash
pnpm install
pnpm build
pnpm test
pnpm dev
```

## Documentation

- [Docs index](docs/README.md)
- [Architecture](docs/architecture/overview.md)
- [ADRs](docs/adr/README.md)
- [Implementation plan](docs/architecture/implementation-plan.md)

## License

[MIT](LICENSE)
