-- ============================================================================
-- llm-quota Row-Level Security (RLS)
--
-- Defense-in-depth for tenant isolation (requirements 8/9). Applied in Phase 2
-- via drizzle-kit custom SQL. Each tenant table is restricted to the owning
-- user's rows; supervisors/admins keep read/view paths.
--
-- Expected connection role: the app connects as a role that has RLS applied.
-- Server sets `app.user_id`, `app.is_admin`, `app.is_supervisor_admin` session
-- settings once per request (see Phase 4/5 auth middleware).
-- ============================================================================

-- Optional: create the app role (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'llmquota_app') THEN
    CREATE ROLE llmquota_app LOGIN;
  END IF;
END $$;

-- ---- users (tenant root) ----
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_own ON users
  USING (id::text = current_setting('app.user_id', true))
  WITH CHECK (id::text = current_setting('app.user_id', true));
CREATE POLICY users_admin_read ON users
  FOR SELECT USING (current_setting('app.is_admin', true) = 'true');

-- ---- connections ----
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY connections_own ON connections
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
CREATE POLICY connections_admin_read ON connections
  FOR SELECT USING (current_setting('app.is_supervisor_admin', true) = 'true');

-- ---- quota_sessions ----
ALTER TABLE quota_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY quota_sessions_own ON quota_sessions
  USING (EXISTS (
    SELECT 1 FROM connections c
    WHERE c.id = quota_sessions.connection_id
      AND c.user_id::text = current_setting('app.user_id', true)
  ));

-- ---- quota_snapshots ----
ALTER TABLE quota_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY quota_snapshots_own ON quota_snapshots
  USING (EXISTS (
    SELECT 1 FROM connections c
    WHERE c.id = quota_snapshots.connection_id
      AND c.user_id::text = current_setting('app.user_id', true)
  ));

-- ---- spending_aggregates ----
ALTER TABLE spending_aggregates ENABLE ROW LEVEL SECURITY;
CREATE POLICY spending_aggregates_own ON spending_aggregates
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
CREATE POLICY spending_aggregates_admin_read ON spending_aggregates
  FOR SELECT USING (current_setting('app.is_supervisor_admin', true) = 'true');

-- ---- user_sessions ----
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_own ON user_sessions
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
CREATE POLICY user_sessions_admin_read ON user_sessions
  FOR SELECT USING (current_setting('app.is_supervisor_admin', true) = 'true');

-- ---- Reference/shared/system tables ----
-- fx_rates, quota_providers, identity_providers, totp_secrets and
-- webauthn_credentials are intentionally NOT tenant-scoped: providers and
-- identity providers are reference data, FX rates are a shared daily cache,
-- and TOTP/WebAuthn secrets are bound at the application layer. RLS stays off
-- for these.
