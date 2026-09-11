# API Conventions

This document defines the canonical conventions for the llm-quota REST API:
HTTP verb usage (all verbs, including **QUERY**), transport security
(TLS 1.3 + HTTP/3), error handling, idempotency, pagination and rate limiting.
It applies from [Phase 5](implementation-plan.md) onward and is normative for
all HTTP surfaces (edge browser↔api and internal api↔collectors).

## Versioning

- OpenAPI contract: **v3.2.0** (with `3.2.1` editorial patch accepted). OAS 3.2
  natively models the **QUERY** method via the `path-item-query` fixed field and
  arbitrary methods via `additionalOperations`. This supersedes the earlier
  OAS 3.1 stance that lacked `query`.
- See [ADR-008](adr/ADR-008-rest-api-tls-quic-query.md).

## Verb matrix

The API uses the full HTTP verb set (RFC 9110 + RFC 10008). Each operation maps
to one verb by its semantics; there is **no overloading of POST for safe reads**.

| Method      | Safe | Idempotent |  Cacheable  | Use in llm-quota                                                                                                          |
| :---------- | :--: | :--------: | :---------: | :------------------------------------------------------------------------------------------------------------------------ |
| **GET**     | yes  |    yes     |     yes     | Simple reads with primitive/URI params (single resource, list with cursor)                                                |
| **QUERY**   | yes  |    yes     |     yes     | **Complex body-based safe reads** (spending history filters, batch lookups) — the canonical verb for heavy read contracts |
| **POST**    |  no  |     no     | conditional | Creation and non-safe mutations (connect, trigger job)                                                                    |
| **PUT**     |  no  |    yes     |     no      | Full replace (idempotent)                                                                                                 |
| **PATCH**   |  no  |     no     | conditional | Partial update (e.g. label, enabled)                                                                                      |
| **DELETE**  |  no  |    yes     |     no      | Remove a resource                                                                                                         |
| **HEAD**    | yes  |    yes     |     yes     | Cheap presence/health probe (no body)                                                                                     |
| **OPTIONS** | yes  |    yes     |     no      | CORS preflight / capabilities                                                                                             |

### QUERY method (RFC 10008)

- **When to use**: any read that needs a complex JSON request body (nested
  filters, group-by, multi-currency, long time ranges) and that is _safe_ and
  _idempotent_. Prefer QUERY over GET-with-body-overload and over
  POST-for-read.
- **Cache key**: `Method + URI + sha256(canonicalized request body)`. Bodies are
  canonicalized (sorted keys, stable JSON) so semantically identical queries
  share a cache entry. The body hash also feeds the `ETag`.
- **Server support**: Node core accepts the `QUERY` token; use a framework with
  first-class arbitrary-method routing — **Hono** (`app.query`) or **Express 5**
  (`app.all`). **Fastify requires `addHttpMethod` opt-in** — avoid unless
  configured.
- **SPA compatibility**: browsers do not emit `QUERY` without a CORS preflight
  (QUERY is not a CORS-safelisted method; see RFC 10008 §4). The Vue frontend
  (Phase 6) therefore uses a **GET compatibility alias** that shares the same
  handler. The API/gateway-to-API contract stays canonical on QUERY.
- **Ingress**: the edge/ingress MUST allow `QUERY` explicitly. Envoy and Caddy
  are method-agnostic; nginx `limit_except` and most managed WAF/ALB rules block
  unknown methods with `405` unless allow-listed. Pick the ingress
  accordingly (see deploy).

### Implemented endpoints (Phase 5, Hono)

Framework: **Hono** (`app.get`/`app.on("QUERY", …)`). All routes are behind the
`Authorization: Bearer <session-token>` middleware, which resolves the principal
and (in real deployment) sets the `app.*` RLS GUCs.

| Method   | Path                 | Description                                                           |
| :------- | :------------------- | :-------------------------------------------------------------------- |
| `GET`    | `/v1/connections`    | List the caller's provider connections (cursor paginated)             |
| `POST`   | `/v1/connections`    | Create a connection; `secret` passed via `x-secret` header and sealed |
| `GET`    | `/v1/quotas`         | Current quota snapshots for the caller's connections                  |
| `GET`    | `/v1/quotas/summary` | Aggregated view (requires `supervisor`+); RBAC `hasRole`              |
| `QUERY`  | `/v1/history`        | Complex safe/idempotent body-based history read (RFC 10008)           |
| `GET`    | `/v1/history`        | **SPA compatibility alias** sharing the same handler                  |
| `GET`    | `/v1/sessions`       | List the caller's active sessions                                     |
| `DELETE` | `/v1/sessions/:id`   | Revoke a session (owner-scoped)                                       |

Errors use RFC 7807 `application/problem+json`; mutations accept
`Idempotency-Key`; list reads use cursor pagination; rate-limit headers are
returned on quota-limited endpoints. The `QUERY`/`GET` history alias shares one
handler so the browser (Phase 6) and API/gateway clients agree.

## Transport security — TLS 1.3 + HTTP/3

Transport and application semantics are distinct; apply each to the right layer.

| Link                          | Protocol                          | Policy                                                                                                                                                                                                                                 |
| :---------------------------- | :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Edge (browser ↔ web/api)**  | HTTP with TLS                     | **TLS 1.3 mandatory**; HTTP/2 + HTTP/3 (QUIC) supported; **HTTP/3 preferential** when the ingress supports it (UDP 443 + ALPN `h3`), with automatic fallback `h2 → h1.1`. TLS 1.2 is deprecated on the edge after a transition window. |
| **Internal (api ↔ postgres)** | Postgres native protocol over TCP | **TLS 1.3-only** (`ssl_min_protocol_version = TLSv1.3`); **no HTTP/3** — Postgres uses its native wire protocol, not HTTP. Client connection string uses `sslmode=verify-full` + `sslrootcert`.                                        |

- Cipher suites (TLS 1.3, AEAD-only):
  `TLS_AES_256_GCM_SHA384`, `TLS_AES_128_GCM_SHA256`,
  `TLS_CHACHA20_POLY1305_SHA256`.
- HTTP/3 is **preferential, never enforced** — clients fall back gracefully.
- Edge headers: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`,
  `Content-Security-Policy: default-src 'self'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`.

## Local TLS (test only)

- For **local development/testing only**, a **self-signed certificate** is
  generated by `scripts/cert-local.sh` into `certs/`.
- The `certs/` directory (including `*.crt`) is **git-ignored** and is
  **never committed**.
- Environment variables `TLS_CERT_PATH` / `TLS_KEY_PATH` point to the local
  files; a hard guard **refuses to load `local.*` in `NODE_ENV=production`**.
- **Production always uses a certificate issued by a real CA** (e.g.
  Let's Encrypt via ACME) with automatic renewal. See [deploy.md](../deploy.md).

## Errors — RFC 7807 (Problem Details)

Errors use `Content-Type: application/problem+json`:

```json
{
  "type": "https://api.llm-quota.dev/errors/insufficient-credits",
  "title": "Insufficient credits",
  "status": 422,
  "detail": "The account has 5 credits but 12 are required.",
  "instance": "/v1/quotas/8c9d...",
  "invalid_params": [{ "name": "amount", "reason": "exceeds available" }]
}
```

## Idempotency

- All non-idempotent mutations (`POST`, `PATCH`) MUST be sent with an
  `Idempotency-Key: <uuid>` header. The server stores the key with a TTL
  (e.g. 24 h) and returns the cached original response on replay without
  reprocessing.
- `PUT` / `DELETE` are naturally idempotent.

## Pagination & rate limiting

- **Cursor pagination**: `GET /v1/...?limit=50&starting_after=<cursor>` →
  `{ "data": [...], "has_more": true, "next_cursor": "..." }`.
- **Rate limiting headers** (IETF draft):
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; on quota
  exhaustion return `429` with `Retry-After: <sec>`.

## Security posture

- Using QUERY (safe + idempotent) for body-based reads reduces the CSRF /
  ambient-authority surface versus the common POST-for-read convention.
- Mutations remain non-safe `POST`/`PATCH`/`PUT`/`DELETE` — never make a read
  path unsafe purely to carry a body.
- See [security.md](security.md) for authentication, MFA, RBAC and RLS.
