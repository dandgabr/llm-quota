-- ============================================================================
-- Phase C — onboarding authorizers (ADR-015).
--
-- Pre-principal account creation (first admin and invite accept) is executed by
-- narrow SECURITY DEFINER functions that own the whole lifecycle atomically:
-- validate the one-time token, create the account + credential, and mark the
-- token consumed / setup complete — all under an advisory lock. Direct INSERT
-- policies for the setup/invite branches are NOT granted, so a bare GUC (which
-- any role may set) can never create a privileged row.
-- ============================================================================

-- Is the instance still uninitialized (no setup completed)?
CREATE OR REPLACE FUNCTION app_setup_required() RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM instance_settings WHERE setup_completed_at IS NOT NULL);
$$;

-- Store the bootstrap token hash (only while setup is incomplete).
CREATE OR REPLACE FUNCTION app_bootstrap_begin(p_hash text, p_expires_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_open boolean;
BEGIN
  SELECT (setup_completed_at IS NULL) INTO v_open FROM instance_settings WHERE id = 'singleton';
  IF v_open IS FALSE THEN
    RETURN false;
  END IF;
  INSERT INTO instance_settings (id, bootstrap_token_hash, bootstrap_token_expires_at, updated_at)
    VALUES ('singleton', p_hash, p_expires_at, now())
  ON CONFLICT (id) DO UPDATE
    SET bootstrap_token_hash = EXCLUDED.bootstrap_token_hash,
        bootstrap_token_expires_at = EXCLUDED.bootstrap_token_expires_at,
        updated_at = now()
    WHERE instance_settings.setup_completed_at IS NULL;
  RETURN true;
END;
$$;

-- Create the first admin in ONE transaction: validate + consume the token,
-- insert the account + credential, and mark setup complete. Returns the new
-- user id, or NULL when the token is invalid/expired/already used.
CREATE OR REPLACE FUNCTION app_setup_first_admin(
  p_token_hash text,
  p_email text,
  p_password_hash text,
  p_first_name text,
  p_last_name text,
  p_locale text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_ok boolean;
  v_id uuid;
BEGIN
  -- Serialize concurrent setup attempts.
  PERFORM pg_advisory_xact_lock(hashtext('llm_quota:setup'));

  SELECT true INTO v_ok FROM instance_settings
   WHERE id = 'singleton'
     AND setup_completed_at IS NULL
     AND bootstrap_token_hash = p_token_hash
     AND bootstrap_token_expires_at > now()
   FOR UPDATE;
  IF v_ok IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  INSERT INTO users (email, role, first_name, last_name, locale, is_active, email_verified_at)
    VALUES (lower(p_email), 'admin', p_first_name, p_last_name, coalesce(p_locale, 'en'), true, now())
    RETURNING id INTO v_id;

  INSERT INTO user_credentials (user_id, password_hash, password_updated_at)
    VALUES (v_id, p_password_hash, now());

  UPDATE instance_settings
     SET setup_completed_at = now(),
         bootstrap_token_hash = NULL,
         bootstrap_token_expires_at = NULL,
         updated_at = now()
   WHERE id = 'singleton';

  RETURN v_id;
END;
$$;

-- Accept an invite in one transaction: consume it and either create the invited
-- account (email + role from the invite) or reset an existing account's
-- credential. Returns the affected user id, or NULL for an invalid invite.
CREATE OR REPLACE FUNCTION app_invite_accept(
  p_token_hash text,
  p_password_hash text,
  p_first_name text,
  p_last_name text,
  p_locale text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_invite user_invites%ROWTYPE;
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('llm_quota:invite:' || p_token_hash));

  SELECT * INTO v_invite FROM user_invites
   WHERE token_hash = p_token_hash
     AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE user_invites SET accepted_at = now() WHERE id = v_invite.id;

  IF v_invite.user_id IS NOT NULL THEN
    -- Password-reset invite: update the credential and revoke sessions.
    INSERT INTO user_credentials (user_id, password_hash, password_updated_at)
      VALUES (v_invite.user_id, p_password_hash, now())
    ON CONFLICT (user_id) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          password_updated_at = now(),
          updated_at = now();
    UPDATE user_sessions SET revoked = true WHERE user_id = v_invite.user_id;
    RETURN v_invite.user_id;
  END IF;

  INSERT INTO users (email, role, first_name, last_name, locale, is_active)
    VALUES (lower(v_invite.email), v_invite.role, p_first_name, p_last_name, coalesce(p_locale, 'en'), true)
    RETURNING id INTO v_id;

  INSERT INTO user_credentials (user_id, password_hash, password_updated_at)
    VALUES (v_id, p_password_hash, now());

  RETURN v_id;
END;
$$;

-- Remove the pre-principal direct INSERT escape hatches: the definer functions
-- above are the ONLY way to create the first admin / accept an invite.
DROP POLICY IF EXISTS users_setup_insert ON users;
DROP POLICY IF EXISTS users_setup_select ON users;
DROP POLICY IF EXISTS user_credentials_setup_insert ON user_credentials;

-- Restrict EXECUTE to the app role (functions default to PUBLIC).
REVOKE EXECUTE ON FUNCTION app_setup_required() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_bootstrap_begin(text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_setup_first_admin(text, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_invite_accept(text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_setup_is_open() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_invite_role(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_bootstrap_valid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_setup_required() TO llmquota_app;
GRANT EXECUTE ON FUNCTION app_bootstrap_begin(text, timestamptz) TO llmquota_app;
GRANT EXECUTE ON FUNCTION app_setup_first_admin(text, text, text, text, text, text) TO llmquota_app;
GRANT EXECUTE ON FUNCTION app_invite_accept(text, text, text, text, text) TO llmquota_app;
