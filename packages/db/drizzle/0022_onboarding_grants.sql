-- Grant execute permissions on onboarding helper functions to llmquota_app
GRANT EXECUTE ON FUNCTION app_bootstrap_valid(text) TO llmquota_app;
GRANT EXECUTE ON FUNCTION app_setup_is_open() TO llmquota_app;
GRANT EXECUTE ON FUNCTION app_invite_role(text) TO llmquota_app;
