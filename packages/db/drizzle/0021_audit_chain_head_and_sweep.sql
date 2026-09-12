-- ============================================================================
-- Audit chain integrity fixes (post H/F review):
--   * app_audit_head(): SECURITY DEFINER read of the chain head OUTSIDE RLS.
--     record() runs under non-admin principals whose RLS policies cannot see
--     prior events; without this the chain links to NULL and verify() 409s
--     forever in production.
--   * unique index on seq (chain ordinal) — covers head lookup + verify order.
--   * INSERT policy requires event_hash (no unchained rows can be forged).
--   * app_audit_sweep: takes the chain lock, floors the retention window and
--     re-anchors the oldest surviving row after pruning (else verify 409s
--     forever after the first sweep).
--   * app role may only connect over TLS (pg_hba hostssl for the app role).
-- ============================================================================

CREATE OR REPLACE FUNCTION app_audit_head() RETURNS varchar
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT event_hash FROM audit_events ORDER BY seq DESC LIMIT 1;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS audit_events_seq_key ON audit_events (seq);

DROP POLICY IF EXISTS audit_events_insert ON audit_events;
CREATE POLICY audit_events_insert ON audit_events
  FOR INSERT WITH CHECK (
    event_hash IS NOT NULL
    AND (
      actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
      OR (actor_user_id IS NULL AND current_setting('app.is_audit', true) = 'true')
    )
  );

CREATE OR REPLACE FUNCTION app_audit_sweep(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    -- Retention below 30 days is refused (the chain anchor depends on history).
    p_days := 30;
  END IF;
  -- Serialize with writers so the head cannot be pruned mid-chain.
  PERFORM pg_advisory_xact_lock(hashtext('llm-quota:audit'));
  WITH deleted AS (
    DELETE FROM audit_events
     WHERE occurred_at < now() - make_interval(days => p_days)
     RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM deleted;
  -- Re-anchor: the oldest surviving row starts a new chain segment.
  UPDATE audit_events SET prev_hash = NULL
   WHERE seq = (SELECT min(seq) FROM audit_events);
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION app_audit_head() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_audit_head() TO llmquota_app;
