# ADR-015: Onboarding (First-Run Setup and Invite Acceptance)

**Status:** accepted (Phase C — onboarding)

## Context

Two entry paths must exist before anyone can log in: the **first administrator**
on a fresh instance, and an **invited user** accepting a temporary link. Both
create an account *before any principal exists*, which is exactly the situation
FORCE RLS is designed to reject — and where a naive GUC-based policy would let
any role self-authorize a privileged row.

## Decision

**Pre-principal account creation runs in narrow `SECURITY DEFINER` functions**
that read/write state outside RLS (`instance_settings`, `user_invites`):

- `app_setup_first_admin(token_hash, email, password_hash, ...)` — under an
  advisory lock, validates + consumes the bootstrap token with `FOR UPDATE`,
  inserts the account + credential and marks setup complete, in one atomic call.
- `app_invite_accept(token_hash, password_hash, ...)` — under an advisory lock,
  consumes a live invite, then either creates the invited account (email + role
  from the invite) or resets an existing account's credential and revokes its
  sessions.

The direct pre-principal INSERT policies were **removed**: a bare GUC
(`app.is_setup` / `app.is_invite`) can never create a privileged row.

**The bootstrap token is generated at first boot, stored only as a hash, printed
once to stdout, single-use and short-lived.** `start()` calls
`bootstrapFirstRun`, which, when setup is incomplete, mints 256 bits, persists
the hash + TTL via `app_bootstrap_begin`, and prints the plaintext to the
operator's log. It is never stored in env or the DB in plaintext, and consuming
it is atomic (`app_bootstrap_consume` / `app_setup_first_admin`).

**The invite token arrives in the request BODY, never the URL path.** The SPA
reads the raw token from the URL **fragment**, immediately
`history.replaceState`s it away, and POSTs it to `/auth/invites/accept` — so the
token never reaches server logs, `Referer` or history. Invite tokens are opaque
256-bit values stored only as a hash; accept is single-use
(`accepted_at`/`revoked_at`/`expires_at` guarded inside the definer function).

**`email_verified_at` is set only on first-admin setup**, not on invited
accounts: no mailer exists in v1, so an invited account has no proven mailbox.

**Errors are RFC 7807**: `403` for an invalid/expired setup token, `409` once
the instance is initialized (regardless of token), `410 Gone` for an invalid or
already-used invite.

**Frontend:** `/setup` and `/invite` are public wizards sharing an `AccountStep`
component; `/` is a public landing; the dashboard moved to `/dashboard`. The
shell resolves `setupRequired` once at boot and the router guard funnels
everything to `/setup` except the invite flow.

## Consequences

- Easier: a fresh clone is usable without a seed; invites reuse the same
  machinery for password resets; pre-principal creation cannot be self-granted.
- Harder: the operator must read the setup code from the server log; two
  privileged operations live in PL/pgSQL functions (must be migration-managed).
- Rejected: authorizing setup/invite by GUC (self-escalation); token in the URL
  path (logged/leaked); email verification for invited accounts (no mailer);
  the `SEED_ADMIN_*` bootstrap as the primary path (kept as a legacy convenience).

## Amends

- ADR-005 (adds `instance_settings` + the onboarding authorizer functions).
