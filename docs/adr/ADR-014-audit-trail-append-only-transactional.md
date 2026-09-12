# ADR-014: Audit Trail (Append-Only, Transactional)

**Status:** accepted (Phase B — audit)

## Context

The access roadmap requires that **every** create/change/delete of a resource,
connection and user be recorded, regardless of the acting role — a security and
compliance baseline (LGPD/GDPR, ASVS V7). Earlier phases had ad-hoc structured
logs but no durable, queryable trail, and the app role must not be able to
tamper with what it wrote.

## Decision

**One append-only table, `audit_events`.** Columns: `id`, `occurred_at`,
`actor_user_id` (FK `users` **ON DELETE SET NULL**), `actor_role` snapshot,
`action` (closed `audit_action` enum), `target_type`, `target_id`, sanitized
`metadata` jsonb and a `request_id`. Indexes support a stable keyset cursor
`(occurred_at DESC, id DESC)`, actor and target lookups.

**RLS enforces append-only for the app role.** `INSERT` is allowed when
`actor_user_id = current_setting('app.user_id')` (an authenticated actor) or,
for anonymous/system events (failed logins, collector retention), when
`actor_user_id IS NULL` and `app.is_audit = 'true'`. `SELECT` is admin/
supervisor. The migration **REVOKEs UPDATE/DELETE/TRUNCATE** from
`llmquota_app`, so even a future permissive policy could not exploit a
pre-granted privilege.

**Events are written in the SAME transaction as the mutation** they describe:
a failed mutation leaves no orphan event, and a successful one is always
recorded. `recordAudit` runs on the caller's transaction handle.

**Metadata is sanitized by allowlist.** Secret-looking keys are dropped and
strings/arrays capped, recursively into nested objects and arrays, so
credentials can never reach the trail.

**`prev_hash` is deliberately out of scope in v1.** A "best-effort" hash chain
under concurrent writers would either duplicate links or lose them and would
give a false forensic guarantee; correlation is by `request_id` instead. A
tamper-evident chain (serialized by an advisory lock) can be added later.

## Consequences

- Easier: every privileged mutation is attributable and queryable; the trail
  survives user deletion (attribution nulled, not erased); the app role cannot
  edit it.
- Harder: reads are admin/supervisor only; retention is not automated in v1
  (documented follow-up); the `action` enum requires a migration to extend.
- Rejected: writing audit outside the mutation transaction (orphan/suppressed
  evidence); a v1 hash chain (false integrity); per-resource audit tables.

## Amends

- ADR-013 (user-management mutations now emit audit events).
