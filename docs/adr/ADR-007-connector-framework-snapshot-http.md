# ADR-007: Connector Framework — Raw QuotaSnapshot + Injectable HttpClient

**Status:** accepted

## Context

Phase 3 delivers the connector framework and the two v1 concrete connectors
(Ollama Claude, OpenRouter). Two concerns drove the design:

1. **Raw vs normalized data.** Connectors read provider-specific responses that
   come in heterogeneous shapes (percent usage, account credits, capped
   used/limit). Normalization already lives in `core.summarizeQuota`. We did not
   want connectors duplicating that math or leaking domain summary logic.
2. **Testability without credentials.** Contract tests and integration tests must
   run offline with fake provider responses; real credentials must never be
   required in CI nor printed to logs.

## Decision

1. **Connectors return a raw `QuotaSnapshot`** — structurally the shared `Quota`
   union (percent or credits shapes). The connector is responsible for mapping
   its provider payload into this wire shape and *nothing more*; `core`
   normalizes it into `QuotaSummary` via `summarizeQuota`. The "wire
   normalization" in the Phase 3 acceptance is realized as connector →
   `summarizeQuota`.
2. **HTTP is injected.** `ProviderContext` carries an optional `http: HttpClient`
   and `baseUrl`/`apiKey`. The default `createFetchHttpClient()` uses the global
   `fetch` (Node >= 22) at runtime. Tests inject an in-memory `HttpClient` stub
   returning canned fixtures, so parsing and wiring are fully offline.
3. **Secrets hygiene.** `apiKey` is passed per-request in headers and never
   logged; connectors throw sanitized errors (status only).
4. **Registry routes by composite id** `providerId/connectionType`, so multiple
   connection types per provider register as distinct connectors and
   `resolve(providerKey)` lists them.
5. Parsing helpers are exported (`parseOllamaClaudeQuota`,
   `parseOpenRouterQuota`) so payload mapping is unit-tested directly.

## Consequences

- Clean separation: connector reads → raw snapshot → core normalizes.
- Contract + parsing tests run offline with stubs; CI needs no provider
  credentials.
- Adding a connector or connection type is just implementing the
  `ProviderConnector` contract and `register`-ing it.
- Slight indirection (injected Http) trades a bit of boilerplate for strong
  determinism and testability.
