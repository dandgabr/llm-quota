-- ============================================================================
-- Phase B — audit trail RLS + append-only privileges (ADR-014).
--
-- The app role may INSERT (via the actor GUC or the system audit GUC) and
-- SELECT (admin/supervisor) but never UPDATE/DELETE/TRUNCATE an event. Events
-- are written in the same transaction as the mutation they describe.
-- ============================================================================

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- Append: either the authenticated actor, or a system/anonymous caller that
-- explicitly opts in via app.is_audit (failed logins, collector retention).
DROP POLICY IF EXISTS audit_events_insert ON audit_events;
CREATE POLICY audit_events_insert ON audit_events
  FOR INSERT WITH CHECK (
    actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR (actor_user_id IS NULL AND current_setting('app.is_audit', true) = 'true')
  );

DROP POLICY IF EXISTS audit_events_supervisor_read ON audit_events;
CREATE POLICY audit_events_supervisor_read ON audit_events
  FOR SELECT USING (current_setting('app.is_supervisor_admin', true) = 'true');

DROP POLICY IF EXISTS audit_events_admin_read ON audit_events;
CREATE POLICY audit_events_admin_read ON audit_events
  FOR SELECT USING (current_setting('app.is_admin', true) = 'true');

-- Append-only: no UPDATE/DELETE policies exist, and the table-level privileges
-- are revoked so even a future permissive policy cannot be exploited through a
-- pre-granted privilege. INSERT/SELECT stay granted (0001 default privileges).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM llmquota_app;
