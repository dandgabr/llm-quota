-- ============================================================================
-- Phase D — authentication RLS (ADR-016).
--
-- MFA challenges and recovery codes follow the pre-principal pattern: the login
-- flow reads/consumes them BEFORE a session exists, so they run under narrow
-- purpose GUCs set transaction-locally by the server. Append-only revocation
-- stays owner-scoped.
-- ============================================================================

-- ---- auth_challenges: owner + pre-auth (challenge consume) ----------------
ALTER TABLE auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_challenges_own ON auth_challenges;
CREATE POLICY auth_challenges_own ON auth_challenges
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
-- Pre-auth: the login flow sets app.is_auth_challenge + app.challenge_user_id.
DROP POLICY IF EXISTS auth_challenges_challenge ON auth_challenges;
CREATE POLICY auth_challenges_challenge ON auth_challenges
  FOR SELECT USING (
    current_setting('app.is_auth_challenge', true) = 'true'
    AND user_id::text = current_setting('app.challenge_user_id', true)
  );
DROP POLICY IF EXISTS auth_challenges_challenge_update ON auth_challenges;
CREATE POLICY auth_challenges_challenge_update ON auth_challenges
  FOR UPDATE
  USING (
    current_setting('app.is_auth_challenge', true) = 'true'
    AND user_id::text = current_setting('app.challenge_user_id', true)
    AND consumed_at IS NULL
  )
  WITH CHECK (
    current_setting('app.is_auth_challenge', true) = 'true'
    AND user_id::text = current_setting('app.challenge_user_id', true)
  );

-- ---- mfa_recovery_codes: owner + pre-auth consumption ---------------------
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mfa_recovery_codes_own ON mfa_recovery_codes;
CREATE POLICY mfa_recovery_codes_own ON mfa_recovery_codes
  USING (user_id::text = current_setting('app.user_id', true))
  WITH CHECK (user_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS mfa_recovery_codes_challenge ON mfa_recovery_codes;
CREATE POLICY mfa_recovery_codes_challenge ON mfa_recovery_codes
  FOR SELECT USING (
    current_setting('app.is_auth_challenge', true) = 'true'
    AND user_id::text = current_setting('app.challenge_user_id', true)
  );
DROP POLICY IF EXISTS mfa_recovery_codes_challenge_update ON mfa_recovery_codes;
CREATE POLICY mfa_recovery_codes_challenge_update ON mfa_recovery_codes
  FOR UPDATE
  USING (
    current_setting('app.is_auth_challenge', true) = 'true'
    AND user_id::text = current_setting('app.challenge_user_id', true)
    AND used_at IS NULL
  )
  WITH CHECK (
    current_setting('app.is_auth_challenge', true) = 'true'
    AND user_id::text = current_setting('app.challenge_user_id', true)
  );

-- ---- totp_secrets: allow the owner to enroll/update + pre-auth read -------
DROP POLICY IF EXISTS totp_secrets_challenge ON totp_secrets;
CREATE POLICY totp_secrets_challenge ON totp_secrets
  FOR SELECT USING (
    current_setting('app.is_auth_challenge', true) = 'true'
    AND user_id::text = current_setting('app.challenge_user_id', true)
  );

-- ---- collector sweep policy for expired challenges ------------------------
DROP POLICY IF EXISTS auth_challenges_collector_delete ON auth_challenges;
CREATE POLICY auth_challenges_collector_delete ON auth_challenges
  FOR DELETE USING (current_setting('app.is_collector', true) = 'true');
