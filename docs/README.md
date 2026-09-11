# Documentation

This directory is the living technical documentation for **llm-quota**. It is
written in English and grows as each implementation phase lands. Diátaxis-aligned:
reference + how-to + architecture.

## Index

| Path | Topic |
|---|---|
| [Architecture overview](architecture/overview.md) | System architecture, monolith modules, client/server, connector pattern |
| [Implementation plan](architecture/implementation-plan.md) | Phased roadmap (F0–F7) and current status |
| [ADR index](adr/README.md) | Architecture decision records |
| [Docker / deploy](deploy.md) | Deployment topology, compose, TLS, backup, PITR |

## Conventions

- Written in **English**.
- Each ADR is immutable once accepted; to supersede a decision write a new ADR
  and set the old one to `superseded`.
- The implementation plan mirrors the phases persisted in ai-memory and is kept
  in sync as work progresses.
