-- ============================================================================
-- F2 — audit retention via SECURITY DEFINER (the app role is append-only).
-- Only this function (owned by the migration role) may delete audit rows; it
-- is exposed solely to the collector path. Deletion by age is the single
-- non-superuser way to prune the trail.
-- ============================================================================
CREATE OR REPLACE FUNCTION app_audit_sweep(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_days IS NULL OR p_days <= 0 THEN
    RETURN 0;
  END IF;
  WITH deleted AS (
    DELETE FROM audit_events
     WHERE occurred_at < now() - make_interval(days => p_days)
     RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM deleted;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION app_audit_sweep(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_audit_sweep(integer) TO llmquota_app;
