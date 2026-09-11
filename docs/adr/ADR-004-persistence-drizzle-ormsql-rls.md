# ADR-004: Persistence Layer — Drizzle ORM, SQL Migrations and Tenant RLS

**Status:** accepted

## Context

Phase 2 needs a PostgreSQL persistence layer for the modular monolith
(`packages/db`). ADR-001 left the ORM choice open ("Prisma/Drizzle"). The schema
must model users, profiles/RBAC, identity providers (OIDC), quota providers,
connections (multi-label, connection type), quota snapshots, the two distinct
session entities (user vs quota/work), spending aggregates, and an FX rate cache.
The security review (ADR-001 §3) requires encrypted secret columns via envelope
encryption, and requirements 8/9 mandate multi-tenant data isolation.

## Decision

1. **Drizzle ORM** — TypeScript-first schema as code, versioned SQL migrations,
   no codegen step, lightweight fit for the pnpm/Turborepo monorepo, strong type
   control. Rejected Prisma (codegen + heavier opinionation) and a raw SQL driver
   alone (more manual work than needed for v1).
2. **Versioned SQL migrations** via Drizzle Kit — schema in
   `packages/db/src/schema/*.ts`, migrations emitted as idempotent SQL under
   `packages/db/drizzle/`.
3. **Tenant Row-Level Security (RLS) active from this phase** — enable RLS on
   tenant tables and add policies keyed by `user_id` (and the `supervisor`/`admin`
   read paths) so a client connection can never read or write another tenant's
   rows, independent of application-layer checks.
4. **Separate session entities** — `user_sessions` (authenticated login) and
   `quota_sessions` (provider work session: % remaining + time-to-reset), per ADR-003.
5. **FX rate cache table** — `fx_rates` backing the `CurrencyRateSource` interface
   (daily cache policy), resolving the Phase 1 deferred piece.
6. **HistoryStore** — `packages/db` implements the `packages/core` `HistoryStore`
   interface, persisting only aggregates (daily/weekly/monthly) with the 12-month
   retention/eviction boundary.

## Consequences

- Data layer is type-safe end-to-end (Drizzle row types + TS).
- RLS provides defense-in-depth for BOLA at the storage tier; application RBAC is
  still enforced separately.
- Migrations are committed SQL, reversible, and reviewable.
- Deferred: Prisma-style admin tooling and per-provider microservice persistence
  (rejected; single shared schema per ADR-001).
