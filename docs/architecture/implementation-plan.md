# Implementation plan

This document tracks the phased implementation of **llm-quota**. It mirrors the
plan persisted in ai-memory and is updated as each phase progresses.

Current status: **Phase 0 complete** (bootstrap). Ready for **Phase 1**.

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

## Phase 1 — Domain Core

Quota windows (session/daily/weekly/monthly), percentage calculus, monetary
credits, currency conversion (FX), 12-month history retention with
daily/weekly/monthly aggregates and session-cycle rollup. Models user session and
quota/work session as separate entities.

## Phase 2 — PostgreSQL Schema, Migrations & Repositories

Users, profiles/RBAC, identity providers/OIDC, quota providers, connections
(multi-label, connection type), quota snapshots, user sessions, quota/work
sessions, spending aggregates; encrypted secret columns; RLS; migrations + seed.
Indexes EXPLAIN-verified.

## Phase 3 — Connector Framework + Provider Registry

`ProviderConnector` contract + `ProviderRegistry`, and concrete connectors
**Ollama Claude** and **OpenRouter (API)** with label autodetection. Contract
tests + registry routing by `providerId + connectionType`.

## Phase 4 — Security Layer

Envelope encryption (DEK/KEK, AES-256-GCM), OAuth token storage, `auth` OIDC
abstraction, TOTP + WebAuthn, RBAC enforcement. ASVS L2 review.

## Phase 5 — Backend API & Collection/Scheduling

REST API (connections, quotas, history), job scheduler minimizing polling
(staggered, per-window TTL), DTOs. Integration tests + performance smoke.

## Phase 6 — Web Frontend (Vue 3 SPA)

Auth (login, MFA), profile/roles, connect providers, connections with labels,
quota/percentage views, spending history charts, currency display, i18n en/pt-BR.
QA E2E (Playwright).

## Phase 7 — Deployment & Hardening

docker-compose (api, web, postgres), env/TLS 1.3, CSP/HSTS/rate limiting,
backup/PITR, observability.

---

## Open items

None — all previously open scope questions were resolved via
[ADR-003](adr/ADR-003-confirmed-scope.md) (UI framework, FX source, connector v1
scope, session semantics, granularity, deploy, supervisor RBAC).

## Key decisions

- ADR-001 modular monolith + connector pattern + envelope encryption + OIDC + 12-month retention.
- ADR-002 i18n ICU MessageFormat on JSON v4 (i18next), `en` + `pt-BR`.
- ADR-003 confirmed scope choices.
