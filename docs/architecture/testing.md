# Testing strategy

Status: plan — applied from [Phase 1](architecture/implementation-plan.md); connector contract tests landed in **Phase 3**.

## By layer

- **Unit** (Vitest, per package):
  - `core`: window math, percentage, currency conversion, retention policy,
    aggregate rollups (BVA/equivalence boundaries).
  - `auth`: OIDC abstraction, TOTP/WebAuthn flow functions, RBAC helpers.
  - `i18n`: message resolution, `en` / `pt-BR` / fallback.
- **Connector contract tests** (Phase 3, landed): each `ProviderConnector` is
  validated against an in-memory `HttpClient` stub returning canned provider
  fixtures (parsing + normalize via `core.summarizeQuota`), so no credentials or
  network are needed in CI. Registry routing (composite id / multi
  connection-type) is also tested. See ADR-007.
- **Integration** (Phase 5): API endpoints against Postgres; scheduler tests
  prove minimized polling (staggered, per-window TTL); N+1-free repository
  queries verified with EXPLAIN.
- **E2E** (Phase 6, Playwright): core journeys — connect Ollama Claude, view
  daily/weekly/monthly %, view history, switch locale. UI/UX + linguistic review
  of copy.

## Security tests

- Secret-leakage oriented tests: keys are never plaintext at rest and never
  emitted in logs.
- Authentication/MFA flows covered automatically.
- BOLA checks (supervisor cannot mutate others' data).

## Quality signals

- Lint + typecheck + test on every PR (CI).
- Mutation/boundary analysis for percentage and window calculations.
