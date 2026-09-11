# Testing strategy (caderno de testes)

Status: **Phase 8 — full dedicated test phase**. Built from an orchestrated review
(QA, security, backend, frontend, optimizer). This is the canonical living test
notebook, one section per layer.

## 1. Test pyramid & coverage matrix

Strong unit coverage today: core (crypto/windows/scheduler/history/percent),
auth (session/oidc/totp/webauthn/rbac), providers (connectors + registry via
HttpClient stub), i18n, shared, api (server/app/collector smoke + 401/QUERY),
web (ApiClient/router/theme, jsdom).

**Remaining gaps targeted by Phase 8** (all greenfield):
- Integration to a **real Postgres** (Drizzle migrations + RLS + seed).
- **API E2E over the wire** through `buildServer` (real socket), incl. the
  `QUERY` (RFC 10008) + GET alias, RFC 7807, idempotency.
- **Playwright usability** (login, connect, quota %, history chart, i18n, theme,
  admin RBAC, a11y/axe).
- **Security smoke** (RLS tenant isolation, secret-at-rest/never-on-wire, CORS,
  MFA challenge, no-leak).
- **Performance / N+1** (EXPLAIN ANALYZE, query-count) + **mutation score**.

## 2. Pre-requisite fixes (Phase 8 P0 bugs, from review)

| # | Bug | Location | Why it blocks tests |
|---|-----|----------|---------------------|
| 1 | `withRlsContext` defined but **never called** → under app role every tenant `FORCE` policy evaluates NULL → 401/`[]` | `sessions.ts:112`, `app.ts:68-83` | RLS cannot be proven / every route broken |
| 2 | Several endpoints hardcode `[]`/`{}` (connections/quota/history) instead of reading repos | `app.ts:119-121,144,146-152,155-175` | E2E can't assert real data |
| 3 | `POST /auth/issue-session` mints a session for **any** `userId` unauthenticated + hardcoded `SESSION_SECRET` fallback + leaks PKCE `code_verifier` | `app.ts:104-117,88-93` | Total-compromise surface; must be gated |
| 4 | Collector mis-maps `monthly`/`session`/`lifetime` windows to `granularity='daily'` (keeps `window:'monthly:…'`) and never runs the 3-granularity rollup | `collector.ts:102`, `history.ts:rollupSessionBatch` | Monthly aggregates never produced |
| 5 | No `listByUser` on `PostgresConnectionStore` | `connections.ts` | `GET /v1/connections` can't be tested |

## 3. Integration — real Postgres (docker/podman)

- `docker/compose.test.yaml`: `postgres:17-alpine`, DB `llm_quota_test`, fixed
  port, no named volume, `pg_isready` health gate; **engine-agnostic** (docker OR
  podman).
- `packages/db/test/helpers/db.ts`: migrate (drizzle) + RLS + seed; **two
  handles** — `superuser` (migrate/seed/bypass) vs **`llmquota_app`** (mortar
  role, subject to `FORCE` RLS) + a `connectAsRole` helper.
- Suites: sessions/resolvePrincipal (RLS negative), connections envelope
  round-trip (raw row never holds plaintext; wrong KEK throws; owner scoping),
  history aggregates (C1 increment, cross-granularity, eviction), collector
  against real tables, FX cache.

## 4. API E2E over the wire

- `apps/api/test/e2e/app.e2e.test.ts` boot `buildServer({port:0,…,db:real,kek})`,
  fetch over `@hono/node-server`.
- Cases: `/health`; 401 no/bad token; quotas; POST/POST-read connections
  (asserts plaintext never echoed); BOLA (user A can't see B); quotas/summary
  RBAC (403 user vs 200 supervisor); `/v1/history` GET alias + **`QUERY`**
  (RFC 10008) share handler; sessions list/revoke/404; `/auth/oidc/authorize`
  (returns challenge/state, NOT verifier); `/auth/mfa/*/challenge`.

## 5. Playwright usability suite (`apps/web/e2e`)

- `playwright.config.ts`: `webServer` builds SPA (`VITE_API_URL=127.0.0.1:3100`)
  + a seeded stub API (`e2e/support/api-stub.ts`); `baseURL:4173`.
- Specs: login (redirect, empty/invalid token `role=alert`, valid→dashboard,
  admin), connect-provider (disabled until key, add→list, secret only in
  `x-secret`), quota-dashboard (donut `role=img`+`aria-label`, status tones,
  skeleton→data, empty/error), history (daily default, granularity toggle, **GET
  alias not QUERY**, empty), i18n (en/pt-BR + persist), theme (light/dark +
  `prefers-color-scheme` + reload), admin-rbac (user/supervisor redirect, admin
  allowed), a11y (`@axe-core/playwright` contrast light+dark, focus visibility,
  `role=alert`, reduced-motion).

## 6. Security smoke

- Secret at rest / never on wire (raw row `v1.…` ≠ plaintext; response/audit-log
  exclude `x-secret`); BOLA/RLS tenant isolation (two users, `llmquota_app`),
  supervisor read-only; RBAC vertical; wrong-KEK throws; session hygiene
  (expired/revoked→401); CORS single-origin + evil-origin; OIDC state/PKCE
  constant-time; no stack-trace in `problem()`.

## 7. Performance / N+1 / mutation

- `EXPLAIN ANALYZE`: `listByUser` uses
  `spending_aggregates_user_window_idx` (Index Scan, not Seq); upsert no
  double-count; `resolvePrincipal` ≤2 queries; paging O(log N) (1 query/page);
  collector stagger no thundering herd; eviction bounded.
- **Mutation**: StrykerJS on `@llm-quota/core` (nightly/report-only, `break:70`
  → promote to 80).

## Quality signals

- Lint + typecheck + unit on every PR. Integration/E2E gated on merge (needs
  docker/podman). Playwright nightly. Mutation + perf report-only nightly.

