-- F1 — allow the admin purge path to delete a target's credentials.
-- (totp_secrets / mfa_recovery_codes already have admin-write policies.)
DROP POLICY IF EXISTS user_credentials_admin_write ON user_credentials;
CREATE POLICY user_credentials_admin_write ON user_credentials
  FOR ALL
  USING (current_setting('app.users_admin_write', true) = 'true')
  WITH CHECK (current_setting('app.users_admin_write', true) = 'true');
