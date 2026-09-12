ALTER TABLE "user_sessions" ADD COLUMN "signature" varchar(128);

-- ============================================================================
-- Collector system-read policy (final security review, 2026-09).
-- The production pool runs as the non-superuser `llmquota_app` (FORCE RLS
-- applies). The quota collector must enumerate connections across tenants;
-- it does so by setting `app.is_collector = 'true'` via SET LOCAL inside its
-- managed transaction. The GUC is set server-side only — never from request
-- input — so the trust boundary stays the API process itself.
-- ============================================================================
DROP POLICY IF EXISTS connections_collector_read ON "connections";
CREATE POLICY connections_collector_read ON "connections"
  FOR SELECT USING (current_setting('app.is_collector', true) = 'true');

-- Retention eviction runs under the same collector context (cross-tenant
-- DELETE of expired windows/snapshots is otherwise impossible for the
-- non-superuser pool under FORCE RLS).
DROP POLICY IF EXISTS spending_aggregates_collector_delete ON "spending_aggregates";
CREATE POLICY spending_aggregates_collector_delete ON "spending_aggregates"
  FOR DELETE USING (current_setting('app.is_collector', true) = 'true');
DROP POLICY IF EXISTS quota_snapshots_collector_delete ON "quota_snapshots";
CREATE POLICY quota_snapshots_collector_delete ON "quota_snapshots"
  FOR DELETE USING (current_setting('app.is_collector', true) = 'true');