# ADR-018: LGPD Purge and Audit Trail Tamper-Evidence (Hash Chain & Retention)

**Status:** accepted (Phase F — compliance & audit integrity)

## Context

ADR-014 established an append-only audit trail in `audit_events` with RLS policies revoking UPDATE, DELETE and TRUNCATE for the application role (`llmquota_app`). However, two crucial enterprise and regulatory requirements remained open:
1. **LGPD / GDPR Right to Erasure**: Users and regulatory bodies require full erasure of personally identifiable information (PII) upon request, without breaking relational references, historical quotas or the integrity of audit attribution.
2. **Cryptographic Tamper-Evidence**: A purely append-only permission model does not detect offline database tampering (e.g. direct superuser manipulation, storage modifications, or forensic discrepancies). ADR-014 noted that a serialized cryptographic hash chain would be addressed in a follow-up phase.

## Decision

1. **LGPD User Anonymization and Purge (`POST /v1/admin/users/:id/purge`)**:
   - Implemented an audited anonymize operation: `users.anonymized_at` is timestamped.
   - PII fields are sanitized: `email` is transformed to `deleted+<id>@invalid`, `first_name` and `last_name` are set to `NULL`.
   - All associated credentials in `user_credentials`, active sessions in `user_sessions`, TOTP secrets in `totp_secrets`, and MFA recovery codes in `mfa_recovery_codes` are permanently deleted.
   - The user UUID in `users.id` is preserved to avoid orphan foreign keys in `audit_events` and historical spending records.
   - Requires admin role with fresh step-up authentication. Refuses purge (`409 Conflict`) if active provider connections or spending aggregates exist, or if the target is the last administrator.
   - Emits an immutable audit action `user.purged`.
2. **Audit Cryptographic Hash Chain**:
   - `audit_events` includes `seq` (monotonic `bigserial`), `prev_hash` (varchar 64), and `event_hash` (varchar 64).
   - Insertion is serialized under a PostgreSQL transaction-level advisory lock (`pg_advisory_xact_lock(hashtext('llm-quota:audit'))`).
   - The hash of the current chain head is retrieved outside RLS via the `SECURITY DEFINER` function `app_audit_head()`.
   - `event_hash` is computed as `SHA-256(prev_hash || canonical_json(event_fields))`.
   - Verification endpoint `GET /v1/audit/verify` (restricted to admin) walks the chain from genesis, recomputing all hashes and pinpointing the exact sequence number of any tampered or missing row. Legacy unchained events are tolerated as an initial unanchored prefix.
3. **Automated Audit Retention (`AUDIT_RETENTION_DAYS`)**:
   - Pruning is handled exclusively by the `SECURITY DEFINER` function `app_audit_sweep(p_days)`.
   - Configurable via `AUDIT_RETENTION_DAYS` (default 365 days; floor enforced at 30 days).
   - When events are pruned, the oldest surviving event is automatically re-anchored (`prev_hash = NULL`), ensuring subsequent `GET /v1/audit/verify` calls remain valid and unbroken.

## Consequences

- **Easier**: Full compliance with LGPD/GDPR erasure mandates; verifiable audit trail integrity with zero third-party blockchain or external timestamping dependencies.
- **Harder**: Write concurrency on `audit_events` is serialized by the transaction advisory lock; verify endpoint cost scales linearly with audit volume (recommended for periodic background checks).
- **Amends**: ADR-014 (supersedes the omission of `prev_hash` and automated retention).
