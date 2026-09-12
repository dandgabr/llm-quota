#!/bin/bash
# llm-quota — first-boot Postgres provisioning (docker-entrypoint-initdb.d).
#
# Creates the NON-SUPERUSER pool identity `llmquota_app` with the password from
# the POSTGRES_APP_PASSWORD env (required). The superuser (POSTGRES_USER) is
# reserved for migrations/seed; the API pool MUST connect as llmquota_app so
# FORCE RLS tenant isolation is enforced (ADR-005).
set -euo pipefail

: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required to provision the app role}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'llmquota_app') THEN
    CREATE ROLE llmquota_app LOGIN;
  END IF;
END
\$\$;
ALTER ROLE llmquota_app PASSWORD '${POSTGRES_APP_PASSWORD}';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO llmquota_app;
EOSQL

echo "[init-prod] llmquota_app provisioned (password from POSTGRES_APP_PASSWORD)"
