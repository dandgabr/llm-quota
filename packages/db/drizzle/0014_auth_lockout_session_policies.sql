-- ============================================================================
-- E4/E5 — login throttle + session state policies (ADR-016 hardening).
--
-- auth_login_attempts and the session touch are PRE-principal: the server sets
-- purpose GUCs transaction-locally. No client value is ever used as a GUC.
-- ============================================================================

-- ---- session rotation lineage + hot-path indexes --------------------------
ALTER TABLE user_sessions
  ADD CONSTRAINT user_sessions_replaced_by_fk
  FOREIGN KEY (replaced_by) REFERENCES user_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at);
CREATE INDEX IF NOT EXISTS user_sessions_last_seen_idx ON user_sessions (last_seen_at);

-- Scoped touch: only the session whose token_hash the server just verified,
-- and only while it is live. Guards against a pre-auth GUC touching other rows.
DROP POLICY IF EXISTS user_sessions_auth_touch ON user_sessions;
CREATE POLICY user_sessions_auth_touch ON user_sessions
  FOR UPDATE
  USING (
    current_setting('app.is_session_touch', true) = 'true'
    AND token_hash = current_setting('app.session_touch_hash', true)
    AND revoked = false
    AND expires_at > now()
  )
  WITH CHECK (
    current_setting('app.is_session_touch', true) = 'true'
    AND token_hash = current_setting('app.session_touch_hash', true)
  );

-- Collector retention for rotated/expired rows (E5 sweep).
DROP POLICY IF EXISTS user_sessions_collector_delete ON user_sessions;
CREATE POLICY user_sessions_collector_delete ON user_sessions
  FOR DELETE USING (current_setting('app.is_collector', true) = 'true');

-- ---- auth_login_attempts RLS ----------------------------------------------
ALTER TABLE auth_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_login_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_login_attempts_throttle ON auth_login_attempts;
CREATE POLICY auth_login_attempts_throttle ON auth_login_attempts
  FOR ALL
  USING (current_setting('app.is_auth_throttle', true) = 'true')
  WITH CHECK (current_setting('app.is_auth_throttle', true) = 'true');
DROP POLICY IF EXISTS auth_login_attempts_admin_read ON auth_login_attempts;
CREATE POLICY auth_login_attempts_admin_read ON auth_login_attempts
  FOR SELECT USING (current_setting('app.users_admin_write', true) = 'true');
DROP POLICY IF EXISTS auth_login_attempts_collector_delete ON auth_login_attempts;
CREATE POLICY auth_login_attempts_collector_delete ON auth_login_attempts
  FOR DELETE USING (current_setting('app.is_collector', true) = 'true');

-- ---- invalidate legacy recovery codes (E2) --------------------------------
-- Old codes were SHA-256 with no pepper and are incompatible with the HMAC
-- scheme. Users regenerate them after a step-up.
DELETE FROM mfa_recovery_codes;

-- ---- grants for the new table (default privileges do not cover it) ---------
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_login_attempts TO llmquota_app;
