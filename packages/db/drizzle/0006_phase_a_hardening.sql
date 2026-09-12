-- ============================================================================
-- Phase A hardening (post-review): close the setup authorization gap, add the
-- login lookup policy, tighten credential/supervisor reads and add the hot-path
-- indexes found by the performance review.
--
-- The setup INSERT policy no longer trusts a bare GUC: it requires a token hash
-- that ONLY matches the value stored in instance_settings, which the app role
-- cannot read (no policy on instance_settings). A GUC alone is therefore not
-- sufficient to create an admin.
-- ============================================================================

-- ---- bootstrap token authorizer (SECURITY DEFINER, reads outside RLS) ------
CREATE OR REPLACE FUNCTION app_bootstrap_valid(p_token_hash text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM instance_settings
    WHERE bootstrap_token_hash IS NOT NULL
      AND bootstrap_token_hash = p_token_hash
      AND bootstrap_token_expires_at > now()
      AND setup_completed_at IS NULL
  );
$$;

-- Require BOTH the instance-open check AND a matching bootstrap token hash.
DROP POLICY IF EXISTS users_setup_insert ON users;
CREATE POLICY users_setup_insert ON users
  FOR INSERT WITH CHECK (
    role = 'admin'
    AND current_setting('app.is_setup', true) = 'true'
    AND app_setup_is_open()
    AND app_bootstrap_valid(current_setting('app.bootstrap_token_hash', true))
    OR (
      current_setting('app.is_invite', true) = 'true'
      AND role::text = app_invite_role(current_setting('app.invite_token_hash', true))
    )
  );

-- ---- users: login lookup restricted by the target email -------------------
DROP POLICY IF EXISTS users_auth_select ON users;
CREATE POLICY users_auth_select ON users
  FOR SELECT USING (
    current_setting('app.is_auth', true) = 'true'
    AND lower(email) = lower(current_setting('app.auth_email', true))
  );

-- ---- user_credentials: scope the pre-auth read to the target email --------
DROP POLICY IF EXISTS user_credentials_auth ON user_credentials;
CREATE POLICY user_credentials_auth ON user_credentials
  FOR SELECT USING (
    current_setting('app.is_auth', true) = 'true'
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = user_credentials.user_id
        AND lower(u.email) = lower(current_setting('app.auth_email', true))
    )
  );

-- ---- admin read: allow the write path to read back updated rows ------------
-- An UPDATE ... RETURNING evaluates the SELECT policies against the NEW row, so
-- a soft-delete (which sets deleted_at) must remain readable by the admin. The
-- admin list already filters deleted rows in the repository; the supervisor
-- policy below still hides them.
DROP POLICY IF EXISTS users_admin_read ON users;
CREATE POLICY users_admin_read ON users
  FOR SELECT USING (
    current_setting('app.is_admin', true) = 'true'
    OR current_setting('app.users_admin_write', true) = 'true'
  );

-- ---- supervisor read must also hide soft-deleted accounts -----------------
DROP POLICY IF EXISTS users_supervisor_read ON users;
CREATE POLICY users_supervisor_read ON users
  FOR SELECT USING (
    current_setting('app.is_supervisor_admin', true) = 'true'
    AND deleted_at IS NULL
  );

-- ---- hot-path indexes (performance review) --------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_hash_unique
  ON user_sessions (token_hash);
-- Revocation on block/delete and session listing.
CREATE INDEX IF NOT EXISTS user_sessions_user_id_created_at_idx
  ON user_sessions (user_id, created_at DESC);
-- Collector owner enumeration.
CREATE INDEX IF NOT EXISTS connections_user_id_idx ON connections (user_id);
-- Live invite per email (anti-spam / conflict checks).
CREATE INDEX IF NOT EXISTS user_invites_email_live_idx
  ON user_invites (lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---- collector maintenance policy for the idempotency sweep ---------------
DROP POLICY IF EXISTS idempotency_keys_collector_delete ON idempotency_keys;
CREATE POLICY idempotency_keys_collector_delete ON idempotency_keys
  FOR DELETE USING (current_setting('app.is_collector', true) = 'true');
