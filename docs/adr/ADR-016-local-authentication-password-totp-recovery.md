# ADR-016: Local Authentication (Password + TOTP MFA + Recovery)

**Status:** accepted (Phase D — authentication). Amends ADR-001 §auth and ADR-009.

## Context

ADR-001 described OIDC-based authentication, but v1 has no OIDC flow
(`oidc.ts` explicitly skips full `id_token` validation and server-side
state/PKCE), and the app needed a working local login: password, with MFA for
privileged roles. This ADR makes password-first local authentication the
primary v1 path and positions OIDC/SCIM as additive plugins.

## Decision

**Local accounts authenticate with password, then MFA when enrolled.**
`POST /auth/login` looks up the credential by email under the narrow
`app.is_auth` + `app.auth_email` RLS context, verifies the scrypt hash, and
answers uniformly (with a dummy derivation for unknown/inactive/soft-deleted
accounts) so timing does not reveal existence. On success either a session is
issued or — when a verified TOTP secret exists — a **short-lived, single-use
challenge** is returned. `POST /auth/login/mfa` consumes the challenge and
accepts a TOTP code (atomic CAS on `last_used_step`, so a step cannot be
replayed) or a one-time recovery code.

**MFA is mandatory for `admin`/`supervisor`, optional for `user`.** The first
admin is enrolled during `/setup`; role-based enforcement lives in the wizard
and login funnel.

**TOTP secrets are encrypted with the envelope KEK** (ADR-005) and never leave
the server; enrollment returns the secret + `otpauth://` URI once, and only a
first valid code marks the factor verified. Recovery codes (10) are generated at
enrollment, shown once, and stored only as hashes, consumed atomically.

**Break-glass:** an admin can reset another account's MFA
(`DELETE /v1/admin/users/:id/mfa`, audited) — this removes the factors and codes
and revokes sessions, forcing re-enrollment at next login. Self-service disable
is available to the account owner.

**Sessions are opaque bearer tokens** (ADR-009) with a **12h absolute expiry**;
`POST /auth/logout` revokes server-side (not just locally). Changing a password
requires the current password and revokes the account's sessions. Every
authentication outcome is audited.

**WebAuthn register is deferred.** `packages/auth` verifies assertions but not
attestation/COSE→JWK; hand-rolling that was rejected by the security review, so
v1 ships **TOTP-only** and passkeys land later on `@simplewebauthn/server`
(`webauthn_credentials` and the WEBAUTHN_* envs are reserved).

**The `ENABLE_DEV_SESSION` token-paste endpoint was removed**; real login
replaces it.

## Consequences

- Easier: self-hosted login works with zero external dependencies; MFA is real
  for privileged roles; recovery avoids permanent lockout.
- Harder: password hashing (scrypt, memory-hard, concurrency-bounded) and
  challenge/recovery state must be operated; OIDC remains unwired.
- Given up: passkeys and SSO in v1; idle-timeout and per-account lockout are
  documented follow-ups (rate limiting is per-IP in-process).
- Rejected: WebAuthn register hand-rolled in v1; OIDC enabled without full
  `id_token` validation + state/PKCE; disabling MFA via password reset.

## Amends

- ADR-001 §auth (password-first local is the v1 path; OIDC is an optional future
  IdP via `identity_providers`).
- ADR-009 (enrollment + login verification are implemented; MFA is mandatory for
  privileged roles).
