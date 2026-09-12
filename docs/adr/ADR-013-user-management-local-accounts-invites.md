# ADR-013: User Management (Local Accounts, Invites, Soft Delete)

**Status:** accepted (Phase A — user management, post-review hardened)

## Context

Through Phase 8 the system had authentication primitives (sessions, TOTP,
WebAuthn, RBAC) but no way to create or administer users: the `users` table had
no credential, no management API, and no admin panel. The first workstream of
the access roadmap therefore had to deliver, before onboarding/login:

1. **A minimal local account** — only what is required to authenticate (email,
   password, optional name, locale, role). No unnecessary personal data.
2. **A management surface** — invite, change role, block, delete, and a panel
   to operate it.
3. **A first-admin path** — reusing the invite machinery; the bootstrap is
   delivered in Phase C (onboarding).
4. **An audit foundation** — schema lands with this phase (Phase B surfaces it).

Constraints carried from earlier ADRs: FORCE RLS with a non-superuser app role
(ADR-005), no new runtime dependencies unless justified, engine-agnostic
deployment, and the app-role test harness (`llmquota_app` on `:55432`) must
prove isolation adversarially.

## Decision

**Credentials live in `user_credentials`, never on `users`.** A `REVOKE
SELECT(password_hash)` is inert against the table-level `GRANT`, so a separate
table both keeps a plain `select()` from reading hashes and preserves safe DTOs
by construction. `password_hash` is nullable (invited/SSO accounts).

**Passwords use async `scrypt` (Node built-in), PHC-serialized.** Parameters
(N=2^16, r=8, p=1, explicit `maxmem`) are embedded in the stored string so they
can be raised later without invalidating hashes. A global semaphore bounds
derivations (memory-hard: ~64 MiB each) and a dummy verify keeps response time
uniform for unknown accounts. No third-party KDF dependency.

**Soft delete is the default; purge is a separate audited action.** "Delete"
sets `is_active=false` + `deleted_at` and revokes sessions, preserving
connections, spending history and audit attribution. `resolvePrincipal`
rejects `deleted_at IS NOT NULL`. The email unique index is **partial
functional** (`lower(email) WHERE deleted_at IS NULL`), freeing an email for
re-registration after deletion. A later admin "purge/anonymize" operation
handles the LGPD right to erasure.

**Invites are opaque, hashed at rest, single-use and expiring.** `user_invites`
stores only `token_hash`; accept is an atomic `UPDATE ... WHERE accepted_at IS
NULL AND revoked_at IS NULL AND expires_at > now() RETURNING`, so concurrent
accepts resolve to exactly one success. An invite may carry a `user_id` to
serve as a password-reset for an existing account.

**Authorization is not a bare GUC.** GUCs (`app.*`) are a code-organization
signal set transaction-locally by the server, and any role can call
`set_config`. First-admin creation and invite acceptance are therefore
authorized by `SECURITY DEFINER` functions that read state **outside** RLS
(`instance_settings`, `user_invites`) — `app_bootstrap_valid(token_hash)` and
`app_invite_role(token_hash)`. The bootstrap token is generated, stored only as
a hash, printed once to stdout at first boot, and short-lived (full flow in
Phase C / ADR-015). An anti-escalation trigger on `users` additionally gates
role/`is_active` changes to the `app.users_admin_write` GUC (superusers exempt).

**Non-idempotent mutations accept `Idempotency-Key`.** `idempotency_keys` is
keyed `(user_id, key)`, stores the request hash and response snapshot, and is
swept on the collector timer. `/auth/*` is explicitly excluded (replaying a
login would re-issue a session token).

**Errors follow RFC 7807 with a stable `type` catalog** and
`application/problem+json`; the client maps the type URI's last segment to
`ApiError.code` for branching.

**The SPA is served same-origin by the API** (`WEB_DIST_PATH`) with an
`index.html` fallback outside `/v1|/auth|/health`, realpath-confined static
serving, dotfile/source-map denial and a concrete CSP — so `localhost:3000`
shows the app instead of a bare API error.

## Consequences

- Easier: user lifecycle is fully owned by the app; credentials are isolated;
  soft delete preserves financial/audit history; the same invite machinery can
  later serve password resets and (Phase C) the first admin.
- Harder: two tables for an account (`users` + `user_credentials`); soft delete
  requires `deleted_at` discipline in every read path; purge must be built and
  audited separately for LGPD.
- Given up: no email verification (no mailer in v1 — invite link acts as proof
  of mailbox access; `email_verified_at` is set only on first-admin setup);
  idempotency snapshot is stored server-side for 24h.
- Rejected: password hash as a column (inert column REVOKE + DTO leak risk);
  hard delete (cascades financial/audit history); authorizing setup/invite by a
  GUC alone (self-escalation); a third-party KDF dependency (argon2id) in v1.

## Supersedes / amends

- Amends ADR-005 (adds the `user_credentials`, `user_invites`,
  `idempotency_keys`, `instance_settings` tables and their policies).
- Amends ADR-008 (RFC 7807 `type` catalog + `application/problem+json`).
- Amends ADR-012 (dev-session gate now requires `development|test` **and**
  `ENABLE_DEV_SESSION=1`; the endpoint is removed in Phase D).
