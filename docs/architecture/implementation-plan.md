# Implementation plan

This document tracks the phased implementation of **llm-quota**. It mirrors the
plan persisted in ai-memory and is updated as each phase progresses.

Current status: **Phase 5 complete** (REST API + scheduler/collector). Ready for **Phase 6**.

## Phase 0 — Repository & Tooling Bootstrap ✅

- [x] Root monorepo config (pnpm workspaces, Turborepo, TS, ESLint, Prettier, Vitest, CI)
- [x] `apps/web` and `apps/api` skeletons
- [x] `packages/*` scaffolds (core, providers, auth, i18n, db, shared)
- [x] Base CI (lint + typecheck + test) green
- [x] `pnpm dev` runnable

Acceptance met: `pnpm install && pnpm build && pnpm test` are green from a clean
checkout. CI pipeline to be wired in the next commit (GitHub Actions); the local
equivalents all pass.

> Note: `pnpm` must be run from `~/.local/bin` on this machine (global install);
> `packageManager` is pinned to `pnpm@12.3.4`.

## Phase 1 — Domain Core ✅

- [x] Quota window logic (`windows.ts`): calendar anchors for daily/weekly/monthly, `windowKey`.
- [x] Percentage + monetary-credit math (`math.ts`, `percentage.ts`, `credits.ts`): both credit shapes (account total vs used/limit), `summarizeQuota`.
- [x] Currency conversion (`fx.ts`): `CurrencyRateSource` interface + daily-cache policy; DB-backed store deferred to Phase 2.
- [x] History/retention (`history.ts`): 12-month cap, session-cycle rollup into daily/weekly/monthly aggregates, eviction boundary.
- [x] Collection scheduling (`scheduler.ts`): pure `scheduleNext` (per-window interval + reset detection), `stagger`.
- [x] Unit tests (28) incl. BVA boundaries; all green.

Acceptance: window computation, % math, currency conversion, 12-month rollup/eviction and aggregate correctness covered.

## Phase 2 — PostgreSQL Schema, Migrations & Repositories ✅

- [x] Drizzle ORM selected as the persistence layer (see ADR-004).
- [x] Schema (`packages/db/src/schema`): users, profiles/RBAC, identity providers,
      quota providers, connections (multi-label, connection type), quota snapshots,
      user sessions, quota/work sessions, spending aggregates, FX rate cache.
- [x] Encrypted secret columns (envelope-encryption fields reserved: `*_cipher`).
- [x] Versioned SQL migration generated via Drizzle Kit (`drizzle/0000_*.sql`).
- [x] Tenant Row-Level Security SQL (`drizzle/custom/0001_rls.sql`) with
      `app.user_id` / `app.is_admin` / `app.is_supervisor_admin` session settings.
- [x] Repository implementations: `PostgresHistoryStore` (implements core
      `HistoryStore`) and `PostgresFxRateSource` (implements core
      `CurrencyRateSource`).
- [x] Seed script registering the v1 providers (Ollama Claude, OpenRouter).
- [x] `resolveDatabaseConfig` + Drizzle client (`createDb`).

Acceptance: schema maps the domain, FK columns are `uuid`-consistent, and the
monorepo (build/lint/typecheck/test) is green. Note: applying migrations / RLS
requires a Postgres instance (docker-compose phase 7); validated via generated
SQL + unit tests locally.

## Phase 3 — Connector Framework + Provider Registry ✅

`ProviderConnector` contract + `ProviderRegistry`, and concrete connectors
**Ollama Claude** and **OpenRouter (API)** with label autodetection. Contract
tests + registry routing by `providerId + connectionType`.

- [x] `Providence` raw-snapshot contract: connectors return a raw `QuotaSnapshot`
      (shared `Quota` union); `core.summarizeQuota` does the normalization (wire
      normalization). ADR-007.
- [x] Injectable `HttpClient` (`createFetchHttpClient` default; stub in tests) —
      contract + parsing tests run offline with canned fixtures, no credentials.
- [x] Functional connectors `ollama-claude` and `openrouter` with parsing helpers
      (`parseOllamaClaudeQuota`, `parseOllamaClaudeLabel`, `parseOpenRouterQuota`).
- [x] `ProviderRegistry` routes by composite id `providerId/connectionType` and
      `resolve(providerKey)` lists multiple connection types per provider.
- [x] Contract tests (stub), parsing unit tests, connector→core normalization
      integration tests, registry routing tests; all green.

Acceptance met: contract tests pass (fake provider stub via `HttpClient`);
registry routes by `providerId + connectionType`; both connectors return a quota
snapshot in the standard shape and normalize through `core.summarizeQuota`.

## Phase 4 — Security Layer ✅

- [x] Envelope encryption (`packages/core/src/crypto.ts`): AES-256-GCM, per-value
      DEK wrapped by KEK (`LLM_QUOTA_KEK`), versioned payload `v1.…`; fills the
      `*_cipher` columns. ADR-005 Q5.
- [x] Auth primitives (`packages/auth`): RFC 6238 TOTP + `otpauth://` builder,
      WebAuthn assertion verify (ECDSA/P-256), OIDC auth-code + PKCE + state,
      opaque session tokens (SHA-256 at rest), RBAC enforcement.
- [x] `PostgresConnectionStore` seals `connections.secret_cipher` at rest.
- [x] Security review (ASVS L2) completed; HIGH/MED defects fixed (WebAuthn
      clientData base64url, OIDC PKCE/state in auth URL, session signature).

Acceptance met: keys never plaintext at rest; TOTP/WebAuthn flows tested; OIDC
PKCE + state validated; secrets never logged; secret-leakage tests green.

## Phase 5 — Backend API & Collection/Scheduling ✅

- [x] Unified `HttpClient` in `@llm-quota/shared` (`get`+`post`), consumed by
      both `providers` connectors and `auth`/OIDC (ADR-009 consequence).
- [x] **Hono** as the HTTP framework; smoke-tested for arbitrary-method `QUERY`.
- [x] REST endpoints: connections (GET/POST), quotas (GET + summary w/ RBAC),
      history (**`QUERY` / RFC 10008 + `GET` alias** sharing one handler),
      sessions (GET/DELETE); RFC 7807 errors + cursor pagination.
- [x] `PostgresSessionStore` + `ResolvedPrincipal` + `withRlsContext`
      (`SET LOCAL app.*` as strings) for the auth middleware / RLS (ADR-005 Q1).
- [x] Scheduler/collector: `runCollectPass` using core `scheduleNext`/`stagger` +
      `summarizeQuota`, persisting snapshots + aggregates via `PostgresHistoryStore`;
      tests prove minimized polling (skip recent, collect on period reset).

Acceptance met: endpoints tested with stubs; scheduler minimizes polling; DTOs
typed; RLS scoping in place (defense-in-depth + `app.*` GUCs in real deploy).
N+1 verification (EXPLAIN) deferred to when a live Postgres is available (Phase 7).

## Phase 6 — Web Frontend (Vue 3 SPA)

Auth (login, MFA), profile/roles, connect providers, connections with labels,
quota/percentage views, spending history charts, currency display, i18n en/pt-BR.
QA E2E (Playwright). The SPA uses the **GET alias** for body-based reads
(browsers do not emit QUERY without CORS preflight); the canonical API contract
stays QUERY (ADR-008).

## Phase 7 — Deployment & Hardening

docker-compose (api, web, postgres), **TLS 1.3 (only)** + **HTTP/3 (QUIC)
preferential** on the edge with `h2/h1.1` fallback; Postgres TLS 1.3-only;
CSP/HSTS/rate limiting; backup/PITR; observability. Ingress allows QUERY.

---

## Open items

None — all previously open scope questions were resolved via
[ADR-003](adr/ADR-003-confirmed-scope.md) (UI framework, FX source, connector v1
scope, session semantics, granularity, deploy, supervisor RBAC).

## Key decisions

- ADR-001 modular monolith + connector pattern + envelope encryption + OIDC + 12-month retention.
- ADR-002 i18n ICU MessageFormat on JSON v4 (i18next), `en` + `pt-BR`.
- ADR-003 confirmed scope choices.
- ADR-008 REST API: TLS 1.3 + HTTP/3 transport, OpenAPI 3.2 QUERY, RFC 7807,
  idempotency, cursor pagination.
