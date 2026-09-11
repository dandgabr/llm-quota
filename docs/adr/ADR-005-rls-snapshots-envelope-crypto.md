# ADR-005: RLS Enforcement Model, Snapshot Retention and Envelope Crypto Decisions

**Status:** accepted

## Context

A multi-agent review (security, dba, backend, optimizer, QA, architect,
linguistic) of Phases 0–2 surfaced high-confidence defects and five open
questions. This ADR pins the decisions that resolve them before Phase 3.

## Decisions

1. **Q1 — RLS `app.*` settings are set by the auth middleware per request.**
   The authentication middleware (Phase 4/5) resolves the actor from the session
   and, before running a transaction's queries, issues
   `SET LOCAL app.user_id`, `app.is_admin`, `app.is_supervisor_admin`.
   Repositories stay identity-agnostic; RLS enforces per request. The settings
   live inside the managed transaction and are never self-elevated outside it.

2. **Q2 — Fix RLS gaps now (A1, A2, A3).** The RLS must be real:
   - A1: move RLS into a versioned migration registered in the Drizzle journal,
     plus `GRANT` and `ALTER DEFAULT PRIVILEGES`.
   - A2: `ALTER TABLE ... FORCE ROW LEVEL SECURITY` on every tenant table.
   - A3: RLS also on `totp_secrets` and `webauthn_credentials`.

3. **Q3 — Keep `quota_snapshots` with a short retention TTL (7 days).** Raw
   detail is kept for diagnostics and incremental aggregate building but bounded
   (7-day TTL, `read_at` index); the 12-month history remains aggregates-only.

4. **Q4 — MFA tables get both RLS and at-rest encryption.** `totp_secrets` /
   `webauthn_credentials` are RLS-scoped AND their sensitive columns are encrypted.

5. **Q5 — Envelope encryption via native `node:crypto` AEAD.** AES-256-GCM with
   a per-value DEK wrapped by a KEK (from env); payload format versioned
   (nonce + ciphertext + wrapped DEK). No extra cloud dependency (suits self-host v1).

## Consequences

- RLS becomes effective at deployment (via journal-registered migrations), not
  merely documented.
- The app role must be able to `SET LOCAL` the `app.*` settings; the middleware
  manages them transactionally.
- `quota_snapshots` keeps a `read_at`-based retention policy (partition/index)
  and a stable uniqueness key.
- The envelope-crypto shape is defined now so the `*_cipher` columns get a
  concrete versioned payload format in Phase 4.
