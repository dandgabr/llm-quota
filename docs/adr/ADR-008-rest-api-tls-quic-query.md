# ADR-008: REST API Conventions — Transport TLS 1.3 + HTTP/3, OAS 3.2 QUERY

**Status:** accepted

## Context

Phase 5 introduces the REST API; Phase 7 introduces deploy/transport. The user
requires that **all internal and external communication** normalize on
**TLS 1.3** and prefer **HTTP/3 (QUIC)**, and that the REST API use **all HTTP
verbs**, including the new **QUERY** method (RFC 10008) which, being safe and
idempotent, reduces the CSRF/ambient-authority surface versus POST-for-read.

Research verified the current (2026) landscape: OpenAPI **3.2.0/3.2.1** is the
released, canonical spec and natively models `query` (`path-item-query`,
RFC 10008) plus `additionalOperations`; OAS 3.1 lacked `query`. RFC 10008 is a
published Proposed Standard (safe + idempotent). Browsers still do not send
QUERY without a CORS preflight, and some gateways/WAFs (nginx, managed ALB/WAF
rules) block unknown methods with `405`.

## Decision

1. **Transport — TLS 1.3 + HTTP/3 preferential.**
   - Edge (browser ↔ web/api): **TLS 1.3 mandatory**; HTTP/2 + HTTP/3 (QUIC)
     supported; **HTTP/3 preferential** when the ingress supports UDP 443 +
     ALPN `h3`, with automatic fallback `h2 → h1.1`. TLS 1.2 deprecated after a
     transition window.
   - Internal DB (api ↔ postgres): **TLS 1.3-only** (`ssl_min_protocol_version
= TLSv1.3`); **no HTTP/3** — Postgres uses its native wire protocol over
     TCP, not HTTP. Client connection string uses `sslmode=verify-full` +
     `sslrootcert`.
2. **REST verbs — full set.** The API uses GET, QUERY, POST, PUT, PATCH,
   DELETE, HEAD, OPTIONS per RFC 9110 + RFC 10008. **QUERY** is the canonical
   contract for complex safe/idempotent body-based reads (e.g. spending-history
   filtering). Cache key = URI + hash of the canonicalized body.
3. **OpenAPI 3.2.0** is the contract version; it natively represents QUERY via
   `path-item-query` and arbitrary methods via `additionalOperations`. This
   supersedes the earlier OAS 3.1 stance.
4. **SPA compatibility alias.** Because browsers do not emit QUERY without a
   CORS preflight, the Vue frontend (Phase 6) uses a **GET alias** sharing the
   same handler; the API/gateway-to-API contract remains QUERY.
5. **Ingress must allow QUERY.** Choose a method-agnostic ingress (Envoy,
   Caddy) or explicitly allow-list `QUERY`; nginx/managed WAF/ALB require
   explicit config to avoid `405`.
6. **Error format** RFC 7807 (`application/problem+json`); **idempotency**
   via `Idempotency-Key` header (TTL) on non-idempotent mutations; **cursor
   pagination**; **rate-limit headers** (`RateLimit-*`, `429` + `Retry-After`).
7. **Local TLS (test only).** A self-signed cert is generated for local
   development/testing by `scripts/cert-local.sh` into `certs/`. It is
   **git-ignored and never committed**. `NODE_ENV=production` **refuses** to
   load `local.*`. **Production always uses a real-CA certificate** (e.g. ACME /
   Let's Encrypt) with automatic renewal.

Details and normative matrix: `docs/architecture/api-conventions.md`.

## Consequences

- Strong, defense-in-depth transport security across edge and internal DB.
- Clear, consistent verb semantics; safer body-based reads via QUERY.
- The gateway must be QUERY-aware; the SPA uses the GET alias (documented).
- OpenAPI tooling must support 3.2 for full QUERY fidelity; older 3.1
  generators fall back to standard verbs (documented in api-conventions).
- Local TLS certs remain developer-only and out of version control; production
  certificates are CA-issued and auto-renewed.
