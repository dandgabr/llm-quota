-- llm-quota test DB bootstrap (runs as superuser at container init).
-- Creates the non-superuser app role that the Phase 8 integration tests connect
-- as, so FORCE RLS is actually exercised (the cluster superuser would bypass it).

CREATE ROLE llmquota_app LOGIN PASSWORD 'llmquota-app-test';
