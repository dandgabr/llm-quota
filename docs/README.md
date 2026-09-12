# Documentation

This directory is the living technical documentation for **llm-quota**. It is
written in English and grows as each implementation phase lands. Diátaxis-aligned:
reference + how-to + architecture.

## Index

| Path                                                                   | Topic                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Architecture overview](architecture/overview.md)                      | System architecture, monolith modules, connector pattern, runtime dataflow |
| [Security design](architecture/security.md)                            | Session/token model, TLS, CORS, rate limits, envelope crypto, RLS, known limitations |
| [Testing strategy](architecture/testing.md)                            | Test pyramid, integration (real Postgres), wire E2E, Playwright, security smoke |
| [Implementation plan](architecture/implementation-plan.md)             | Phased roadmap (F0–F8) and current status                                  |
| [API conventions](architecture/api-conventions.md)                     | REST verb matrix (incl. QUERY), TLS 1.3/HTTP-3, OAS 3.2, errors/pagination |
| [Environment variables](architecture/environment-variables.md)         | Per-context env reference (api, web/build, compose, seed, reserved)        |
| [Runbook](runbook.md)                                                  | Operations: bootstrap, sessions, backup/restore, PITR, KEK/password rotation, collector |
| [Docker / deploy](deploy.md)                                           | Deployment topology, compose profiles, hardening, backup                    |
| [ADR index](adr/README.md)                                             | Architecture decision records                                              |
| [Code doc conventions](architecture/code-documentation-conventions.md) | TSDoc / doc-comment standard for source code                               |

## ADR numbering note

There is **no ADR-010**: the numbering jumped from ADR-009 straight to
ADR-011. The gap is historical — accepted ADRs are immutable and are never
renumbered, so ADR-012 simply continues after ADR-011.

## Conventions

- Written in **English**.
- Each ADR is immutable once accepted; to supersede a decision write a new ADR
  and set the old one to `superseded`.
- The implementation plan mirrors the phases persisted in ai-memory and is kept
  in sync as work progresses.
- All intra-doc links are relative paths.
