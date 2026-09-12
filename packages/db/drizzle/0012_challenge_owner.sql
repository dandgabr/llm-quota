-- Phase D fix: resolve a challenge's owner outside RLS (chicken-and-egg:
-- the MFA step must know the user before it can scope app.challenge_user_id).
CREATE OR REPLACE FUNCTION app_challenge_user(p_id uuid) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT user_id FROM auth_challenges
   WHERE id = p_id AND consumed_at IS NULL AND expires_at > now();
$$;
REVOKE EXECUTE ON FUNCTION app_challenge_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_challenge_user(uuid) TO llmquota_app;

-- Admin break-glass MFA reset needs write access to the target's factors.
DROP POLICY IF EXISTS totp_secrets_admin_write ON totp_secrets;
CREATE POLICY totp_secrets_admin_write ON totp_secrets
  FOR ALL
  USING (current_setting('app.users_admin_write', true) = 'true')
  WITH CHECK (current_setting('app.users_admin_write', true) = 'true');
DROP POLICY IF EXISTS mfa_recovery_codes_admin_write ON mfa_recovery_codes;
CREATE POLICY mfa_recovery_codes_admin_write ON mfa_recovery_codes
  FOR ALL
  USING (current_setting('app.users_admin_write', true) = 'true')
  WITH CHECK (current_setting('app.users_admin_write', true) = 'true');
