# Architecture Decision Records

This directory holds the architecture decision records (ADRs) for **llm-quota**.
They mirror (and complement) the decisions persisted in ai-memory (project
`llm-quota`, `decisions/`).

Format: Markdown ADR; accepted ADRs are immutable. To supersede, add a new ADR
and set the old one's status to `superseded by [[decisions/<new>]]`.

> Numbering note: there is **no ADR-010** — the sequence jumped from ADR-009 to
> ADR-011. The gap is historical and accepted ADRs are never renumbered.

| ADR                                                           | Title                                                                                 | Status   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| [ADR-001](ADR-001-modular-monolith-connectors-crypto-oidc.md) | Modular monolith v1, connector pattern, envelope encryption, OIDC, 12-month retention | accepted |
| [ADR-002](ADR-002-i18n-format.md)                             | i18n format — ICU MessageFormat on JSON v4 (i18next), `en` + `pt-BR`                  | accepted |
| [ADR-003](ADR-003-confirmed-scope.md)                         | Confirmed scope choices (UI, FX, connectors, session semantics, deploy, RBAC)         | accepted |
| [ADR-004](ADR-004-persistence-drizzle-ormsql-rls.md)          | Persistence layer — Drizzle ORM, SQL migrations, tenant RLS                           | accepted |
| [ADR-005](ADR-005-rls-snapshots-envelope-crypto.md)           | RLS enforcement model, snapshot retention, envelope crypto                            | accepted |
| [ADR-006](ADR-006-code-documentation-standard.md)             | Code documentation standard — TSDoc and English                                       | accepted |
| [ADR-007](ADR-007-connector-framework-snapshot-http.md)       | Connector framework: raw QuotaSnapshot + injectable HttpClient                        | accepted |
| [ADR-008](ADR-008-rest-api-tls-quic-query.md)                 | REST API: TLS 1.3 + HTTP/3 transport, OpenAPI 3.2 QUERY                               | accepted |
| [ADR-009](ADR-009-security-layer-envelope-auth.md)             | Security layer: envelope crypto, TOTP/WebAuthn, OIDC, sessions, RBAC                 | accepted |
| [ADR-011](ADR-011-design-system-flat-pastel.md)                 | Design system: Engineered Minimal Swiss — flat + mute pastel, anti-AI-slop          | accepted |
| [ADR-012](ADR-012-production-runtime-wiring-and-hardening.md)   | Production runtime wiring and hardening (collector, app-role pool, CORS, fail-closed dev endpoints) | accepted |
| [ADR-013](ADR-013-user-management-local-accounts-invites.md)   | User management: local accounts, invites, soft delete, idempotency, same-origin SPA serving          | accepted |

## Status legend

- **proposed** — under consideration, not yet agreed.
- **accepted** — agreed and adopted.
- **superseded** — replaced by a newer decision (link in the body).
