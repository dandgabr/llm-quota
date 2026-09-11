# Testing strategy

Status: plan — applied from [Phase 1](architecture/implementation-plan.md).

## By layer

- **Unit** (Vitest, per package):
  - `core`: window math, percentage, currency conversion, retention policy,
    aggregate rollups (BVA/equivalence boundaries).
  - `auth`: OIDC abstraction, TOTP/WebAuthn flow functions, RBAC helpers.
  - `i18n`: message resolution, `en` / `pt-BR` / fallback.
- **Connector contract tests** (Phase 3): each `ProviderConnector` is validated
  against a fake/stub provider returning the standard quota shape, plus
  integration against a real test account.
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
