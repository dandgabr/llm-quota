-- ============================================================================
-- User-management RLS, triggers and SECURITY DEFINER authorizers (Phase A).
--
-- Authorization model (see docs/architecture/security.md):
--   * GUCs (app.*) are a code-organization signal and are set transaction-locally
--     by the server for the ACTIVE principal. They are NEVER trusted to authorize
--     an INSERT of a privileged row, because any role may issue set_config.
--   * First-run admin creation and invite acceptance are authorized by
--     SECURITY DEFINER functions that read state OUTSIDE row-level security
--     (instance_settings, user_invites). A self-referencing policy over `users`
--     would recurse and is therefore not used.
-- ============================================================================

-- ---- users: admin write policies + soft-delete filters ---------------------
DROP POLICY IF EXISTS users_admin_update ON users;
CREATE POLICY users_admin_update ON users
  FOR UPDATE
  USING (current_setting('app.users_admin_write', true) = 'true')
  WITH CHECK (current_setting('app.users_admin_write', true) = 'true');

DROP POLICY IF EXISTS users_admin_delete ON users;
CREATE POLICY users_admin_delete ON users
  FOR DELETE USING (current_setting('app.users_admin_write', true) = 'true');

DROP POLICY IF EXISTS users_supervisor_read ON users;
CREATE POLICY users_supervisor_read ON users
  FOR SELECT USING (current_setting('app.is_supervisor_admin', true) = 'true');

-- Self-read must also hide soft-deleted rows.
DROP POLICY IF EXISTS users_own ON users;
CREATE POLICY users_own ON users
  USING (
    id::text = current_setting('app.user_id', true)
    AND deleted_at IS NULL
  )
  WITH CHECK (id::text = current_setting('app.user_id', true));

-- Admin read also hides soft-deleted rows (users see live accounts only).
DROP POLICY IF EXISTS users_admin_read ON users;
CREATE POLICY users_admin_read ON users
  FOR SELECT USING (current_setting('app.is_admin', true) = 'true' AND deleted_at IS NULL);

-- ---- users: anti self-escalation trigger ----------------------------------
-- This is a code-organization guard (helps catch a missing admin path early),
-- NOT the security boundary: the boundary is the INSERT policy + the SECURITY
-- DEFINER authorizers. Superusers (migration/seed) are exempt.
CREATE OR REPLACE FUNCTION users_guard_role_change() RETURNS trigger AS $$
DECLARE
  is_super boolean;
BEGIN
  SELECT rolsuper INTO is_super FROM pg_roles WHERE rolname = current_user;
  IF is_super THEN RETURN NEW; END IF;

  IF (TG_OP = 'INSERT') THEN
    IF NEW.role IS DISTINCT FROM 'user'
       AND current_setting('app.users_admin_write', true) IS DISTINCT FROM 'true'
       AND current_setting('app.is_setup', true) IS DISTINCT FROM 'true'
       AND current_setting('app.is_invite', true) IS DISTINCT FROM 'true'
    THEN
      RAISE EXCEPTION 'role assignment requires admin context' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.role IS DISTINCT FROM NEW.role) OR (OLD.is_active IS DISTINCT FROM NEW.is_active) THEN
    IF current_setting('app.users_admin_write', true) IS DISTINCT FROM 'true'
       AND current_setting('app.is_self_password_change', true) IS DISTINCT FROM 'true'
       AND current_setting('app.is_invite', true) IS DISTINCT FROM 'true'
    THEN
      RAISE EXCEPTION 'role/active change requires admin context' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_guard_role_change ON users;
CREATE TRIGGER users_guard_role_change
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_guard_role_change();

-- ---- user_credentials: owner-only access ----------------------------------
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_credentials_own ON user_credentials;
CREATE POLICY user_credentials_own ON user_credentials
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
-- Pre-auth login lookup by email (set after users_auth_select matches).
DROP POLICY IF EXISTS user_credentials_auth ON user_credentials;
CREATE POLICY user_credentials_auth ON user_credentials
  FOR SELECT USING (current_setting('app.is_auth', true) = 'true');

-- ---- user_invites: admin manage + pre-auth accept -------------------------
ALTER TABLE user_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_invites_admin_all ON user_invites;
CREATE POLICY user_invites_admin_all ON user_invites
  USING (current_setting('app.users_admin_write', true) = 'true')
  WITH CHECK (current_setting('app.users_admin_write', true) = 'true');
DROP POLICY IF EXISTS user_invites_accept_select ON user_invites;
CREATE POLICY user_invites_accept_select ON user_invites
  FOR SELECT USING (current_setting('app.is_invite', true) = 'true');
DROP POLICY IF EXISTS user_invites_accept_update ON user_invites;
CREATE POLICY user_invites_accept_update ON user_invites
  FOR UPDATE
  USING (
    current_setting('app.is_invite', true) = 'true'
    AND accepted_at IS NULL
    AND revoked_at IS NULL
    AND expires_at > now()
  )
  WITH CHECK (
    current_setting('app.is_invite', true) = 'true'
    AND accepted_at IS NOT NULL
  );

-- ---- idempotency_keys: owner-only -----------------------------------------
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_keys_own ON idempotency_keys;
CREATE POLICY idempotency_keys_own ON idempotency_keys
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));

-- ---- instance_settings: no direct app access (SECURITY DEFINER only) ------
ALTER TABLE instance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_settings FORCE ROW LEVEL SECURITY;
-- No policies: only the table owner (migrations) and SECURITY DEFINER
-- functions may read/write it. The app role cannot touch it directly.

-- ---- SECURITY DEFINER authorizers -----------------------------------------
-- Read instance setup state OUTSIDE RLS. Invoker still cannot forge it.
CREATE OR REPLACE FUNCTION app_setup_is_open() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM instance_settings WHERE setup_completed_at IS NOT NULL
  );
$$;

-- Return the role carried by a live invite token, or NULL.
CREATE OR REPLACE FUNCTION app_invite_role(p_token_hash text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT role::text FROM user_invites
  WHERE token_hash = p_token_hash
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
  LIMIT 1;
$$;

-- ---- users: first-admin / invite INSERT authorization ----------------------
-- The INSERT policy calls the SECURITY DEFINER authorizers. Setup accepts only
-- role='admin' while setup is open; invite accepts only the invite's own role.
DROP POLICY IF EXISTS users_setup_insert ON users;
CREATE POLICY users_setup_insert ON users
  FOR INSERT WITH CHECK (
    (current_setting('app.is_setup', true) = 'true' AND app_setup_is_open() AND role = 'admin')
    OR (
      current_setting('app.is_invite', true) = 'true'
      AND role::text = app_invite_role(current_setting('app.invite_token_hash', true))
    )
  );

-- Allow the setup/invite transaction to read back the row it just inserted
-- (needed for INSERT ... RETURNING under FORCE RLS).
DROP POLICY IF EXISTS users_setup_select ON users;
CREATE POLICY users_setup_select ON users
  FOR SELECT USING (
    current_setting('app.is_setup', true) = 'true'
    OR current_setting('app.is_invite', true) = 'true'
  );

-- ---- connections: admin manage policies -----------------------------------
DROP POLICY IF EXISTS connections_admin_update ON connections;
CREATE POLICY connections_admin_update ON connections
  FOR UPDATE
  USING (current_setting('app.users_admin_write', true) = 'true')
  WITH CHECK (current_setting('app.users_admin_write', true) = 'true');
DROP POLICY IF EXISTS connections_admin_delete ON connections;
CREATE POLICY connections_admin_delete ON connections
  FOR DELETE USING (current_setting('app.users_admin_write', true) = 'true');

-- ---- user_sessions: admin revoke policy -----------------------------------
DROP POLICY IF EXISTS user_sessions_admin_update ON user_sessions;
CREATE POLICY user_sessions_admin_update ON user_sessions
  FOR UPDATE
  USING (current_setting('app.users_admin_write', true) = 'true')
  WITH CHECK (current_setting('app.users_admin_write', true) = 'true');

-- ---- grants for the new tables (ALTER DEFAULT PRIVILEGES did not apply) ---
GRANT SELECT, INSERT, UPDATE, DELETE ON
  user_credentials, user_invites, idempotency_keys TO llmquota_app;
