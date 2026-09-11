# Architecture Decision Records

This directory holds the architecture decision records (ADRs) for **llm-quota**.
They mirror (and complement) the decisions persisted in ai-memory (project
`llm-quota`, `decisions/`).

Format: Markdown ADR; accepted ADRs are immutable. To supersede, add a new ADR
and set the old one's status to `superseded by [[decisions/<new>]]`.

| ADR | Title | Status |
|---|---|---|
| [ADR-001](ADR-001-modular-monolith-connectors-crypto-oidc.md) | Modular monolith v1, connector pattern, envelope encryption, OIDC, 12-month retention | accepted |
| [ADR-002](ADR-002-i18n-format.md) | i18n format — ICU MessageFormat on JSON v4 (i18next), `en` + `pt-BR` | accepted |
| [ADR-003](ADR-003-confirmed-scope.md) | Confirmed scope choices (UI, FX, connectors, session semantics, deploy, RBAC) | accepted |
| [ADR-004](ADR-004-persistence-drizzle-ormsql-rls.md) | Persistence layer — Drizzle ORM, SQL migrations, tenant RLS | accepted |
| [ADR-005](ADR-005-rls-snapshots-envelope-crypto.md) | RLS enforcement model, snapshot retention, envelope crypto | accepted |

## Status legend

- **proposed** — under consideration, not yet agreed.
- **accepted** — agreed and adopted.
- **superseded** — replaced by a newer decision (link in the body).
