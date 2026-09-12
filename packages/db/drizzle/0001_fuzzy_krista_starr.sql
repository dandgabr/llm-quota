-- ============================================================================
-- llm-quota tenant Row-Level Security (ADR-005)
--
-- Applied via `drizzle-kit migrate` (registered in the Drizzle journal).
-- Tenant isolation (requirements 8/9): every tenant table is FORCE-locked to
-- the owning user_id via the app.user_id session setting; reference/shared data
-- (quota_providers, identity_providers, fx_rates) stays non-tenant by design.
--
-- Prerequisite: an app role used by the server pool (e.g. llmquota_app). The
-- auth middleware (Phase 4/5) must set app.user_id / app.is_admin /
-- app.is_supervisor_admin via SET LOCAL inside each managed transaction.
-- ============================================================================

-- ---- App role (idempotent) ----
-- NOTE: the role is created WITHOUT a password here; provisioning sets it via
-- `ALTER ROLE llmquota_app PASSWORD ...` from a secret (docker/pg/init-prod.sh
-- for compose, docker/pg/init.sql for tests). Never commit a role password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'llmquota_app') THEN
    CREATE ROLE llmquota_app LOGIN;
  END IF;
END $$;

-- ---- Grant table privileges to the app role (idempotent) ----
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO llmquota_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO llmquota_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO llmquota_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO llmquota_app;

-- ---- users (tenant root) ----
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_own ON users
  USING (id::text = current_setting('app.user_id', true))
  WITH CHECK (id::text = current_setting('app.user_id', true));
CREATE POLICY users_admin_read ON users
  FOR SELECT USING (current_setting('app.is_admin', true) = 'true');

-- ---- totp_secrets (MFA, tenant-scoped; ADR-005 A3) ----
ALTER TABLE totp_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE totp_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY totp_secrets_own ON totp_secrets
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
CREATE POLICY totp_secrets_admin_read ON totp_secrets
  FOR SELECT USING (current_setting('app.is_admin', true) = 'true');

-- ---- webauthn_credentials (MFA, tenant-scoped; ADR-005 A3) ----
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY webauthn_credentials_own ON webauthn_credentials
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
CREATE POLICY webauthn_credentials_admin_read ON webauthn_credentials
  FOR SELECT USING (current_setting('app.is_admin', true) = 'true');

-- ---- connections ----
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE ROW LEVEL SECURITY;
CREATE POLICY connections_own ON connections
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
CREATE POLICY connections_supervisor_view ON connections
  FOR SELECT USING (current_setting('app.is_supervisor_admin', true) = 'true');

-- ---- quota_sessions ----
ALTER TABLE quota_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY quota_sessions_own ON quota_sessions
  USING (EXISTS (
    SELECT 1 FROM connections c
    WHERE c.id = quota_sessions.connection_id
      AND c.user_id::text = current_setting('app.user_id', true)
  ));

-- ---- quota_snapshots ----
ALTER TABLE quota_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY quota_snapshots_own ON quota_snapshots
  USING (EXISTS (
    SELECT 1 FROM connections c
    WHERE c.id = quota_snapshots.connection_id
      AND c.user_id::text = current_setting('app.user_id', true)
  ));

-- ---- spending_aggregates ----
ALTER TABLE spending_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE spending_aggregates FORCE ROW LEVEL SECURITY;
CREATE POLICY spending_aggregates_own ON spending_aggregates
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
CREATE POLICY spending_aggregates_supervisor_read ON spending_aggregates
  FOR SELECT USING (current_setting('app.is_supervisor_admin', true) = 'true');

-- ---- user_sessions ----
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_own ON user_sessions
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
CREATE POLICY user_sessions_admin_read ON user_sessions
  FOR SELECT USING (current_setting('app.is_admin', true) = 'true');
