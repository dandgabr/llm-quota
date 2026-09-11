# ADR-001: Modular monolith v1, Connector Pattern, Envelope Encryption, OIDC and 12-month History Retention

**Status:** accepted

## Context

llm-quota is a SaaS that monitors AI subscription quotas independently of each
provider's own metric. Requirements demand: (1) relative percentages per time
window (session, daily, weekly, monthly); (2) monetary credits (total account
USD, or used/limit USD); (3) currency conversion to the user's country currency;
(4) local 12-month spending history aggregated per session cycle; (5) multi-user
with TOTP + WebAuthn; (6) multiple providers (some OAuth: Codex, Antigravity,
Claude; some API: OpenAI, Anthropic, Gemini, OpenRouter, OpenCode Go, Ollama,
Ollama Claude, etc.); (7) all keys persisted encrypted with best practices;
(8) decoupled, separately editable systems: frontend, core, provider management,
user management; (9) tailored connectors communicating with a provider-management
integrator; (10) profiles user/supervisor/admin; (11) OIDC-standard auth to allow
future providers/SSO; (12) client/server architecture, initial focus web SaaS;
(13) PostgreSQL preferred, TypeScript stack; (14) first concrete connector:
Ollama Claude; (15) connection labels + multiple connections per provider;
(16) providers with >1 connection type treated separately (e.g. OpenAI/Codex
OAuth vs API); (17) i18n `en` + `pt-BR`; (18) repo/code/docs in English.

## Decision

1. **Modular monolith for v1** (not microservices): deploy one server; internal
   modules (`core`, `providers`, `users`, `i18n`, `web`) communicate via typed
   function/domain boundaries, not network. Microservices are deferred to a
   future v2 only if real scaling or independent-deploy pressure emerges.
   Rationale: single-team SaaS with one concrete connector in v1; microservices
   would add network latency, DTO duplication and operational load with no v1
   benefit.
2. **Connector pattern**: each provider implements a `ProviderConnector`
   interface (quota window reading, monetary credits, connection-type detection,
   label autodetection). A `ProviderRegistry`/integrator holds connectors and
   routes by `providerId + connectionType`.
3. **Envelope encryption for all secrets** (API keys, OAuth tokens): a DEK random
   per secret value, KEK from environment/KMS, AES-256-GCM for payload, KEK never
   stored in DB. OAuth tokens are additionally stored as refresh tokens; access
   tokens are kept in memory/encrypted cache.
4. **OIDC-standard authentication**: local identity via an OIDC provider
   abstraction so Google/GitHub/Discord/SSO federation can be added later
   without rework.
5. **History retention of 12 months**: raw usage snapshots are aggregated into
   daily aggregates; then into weekly and monthly aggregates; raw detail is
   dropped after aggregation per session cycle to bound storage.
6. **i18n via ICU MessageFormat on JSON v4 resource files** (i18next), one file
   per locale (`en.json`, `pt-BR.json`), keys namespaced by feature; see ADR-002
   for the i18n format choice.

## Consequences

- Advantages: single deploy, shared DB schema, low ops overhead for v1, fast
  delivery of the single Ollama Claude connector.
- Disadvantages: hard scaling boundary if a future feature needs independent
  deploys; the monolith must be disciplined about module boundaries from day one.
- Rejected alternatives: microservices (premature for v1); per-provider
  microservices (fragment of connector logic with no benefit); storing secrets
  as plaintext or with a single static key without per-value DEK (fails the
  best-practice requirement).
