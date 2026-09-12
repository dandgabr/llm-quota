-- ============================================================================
-- Session authentication path under the non-superuser pool (live-smoke fix).
--
-- The auth middleware resolves the caller's session BEFORE any principal is
-- known, so the tenant GUCs (app.user_id etc.) are not yet set and FORCE RLS
-- would hide every row from the llmquota_app pool. The server sets
-- app.is_auth = 'true' (transaction-local, server-side only) inside
-- resolvePrincipal's managed transaction; this policy is the narrow grant
-- that makes the token-hash lookup possible. The subsequent user read runs
-- with app.user_id set to the session's owner.
-- ============================================================================
DROP POLICY IF EXISTS user_sessions_auth_select ON "user_sessions";
CREATE POLICY user_sessions_auth_select ON "user_sessions"
  FOR SELECT USING (current_setting('app.is_auth', true) = 'true');
