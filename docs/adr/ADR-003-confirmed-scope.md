# ADR-003: Confirmed Scope Choices (UI, FX, Connectors, Session Semantics, Deploy, RBAC)

**Status:** accepted

## Context

Resolves the previously open scope items in the implementation plan. These were
agreed with the product owner and mirror the decisions persisted in ai-memory.

## Decisions

### UI framework (web)
`apps/web` uses **Vue 3 + Vite + Pinia + Vue Router** (TypeScript SPA). Chosen
over React/Svelte for maturity, small bundle, native Vue I18n wiring, and fit for
an API-consumer web client that future desktop/gadget/GNOME clients share via
the same REST API.

### FX (currency conversion)
- Source: **exchangerate.host** (free tier) — dashboard intent, not financial
  settlement.
- Cadence: **daily refresh + cache** — fetch the rate once/day and cache; no
  intra-day churn.
- Formats via `Intl.NumberFormat` with the user locale; never hardcode a currency
  in a string.

### Connectors v1 (Phase 3)
- Functional connectors: **Ollama Claude** (defined, required) and
  **OpenRouter (API)** — the second validates the `ProviderConnector` pattern
  with two distinct providers.
- **Codex / Antigravity / Claude-OAuth deferred to v2.**
- **Multi connection-type per provider** confirmed: a provider may register
  separate OAuth and API connectors (e.g. OpenAI/Codex via OAuth and via API),
  routed independently via the `ProviderRegistry` by `providerId + connectionType`.

### Session semantics (dual entity)
Two distinct entities, modeled separately:
1. **User session** — the authenticated login of a user (HttpOnly/Secure
   session). Its lifecycle defines user-session rollup boundaries.
2. **Quota/work session** — returned by quota APIs: % of usage remaining and time
   remaining until resolution (reset). It is a provider domain entity, distinct
   from the user session.

### History retention & granularity
- Retain **only aggregates** (daily → weekly → monthly), **no raw detail** — max
  compression for 12-month retention.

### Deploy v1
- **Docker Compose** (api, web, postgres in a **dedicated container**), TLS 1.3,
  backup/PITR.
- Postgres on a dedicated container within the same compose stack.

### Supervisor RBAC scope
The supervisor manages **own** providers/connections **and has a read-only view**
of other users' spend/quota. It does **not** modify third-party data (per
requirement 9).

## Consequences
- Phase 6 is scoped to a Vue 3 SPA.
- Phase 3 delivers two connectors (Ollama Claude + OpenRouter).
- The schema models `user_sessions` and `quota_sessions` as separate entities.
- Phase 7 uses docker-compose with a Postgres container.
- Role definitions are frozen for requirements 8/9 (user / supervisor / admin).
