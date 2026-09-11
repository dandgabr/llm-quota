#!/usr/bin/env bash
# llm-quota — logical restore helper (engine-agnostic: docker OR podman).
#
# Usage:
#   ./docker/restore.sh <dump.sql> [engine]
#
# Restores the given SQL dump into the `postgres` container's `llm_quota` DB.
# For PITR: a base backup from WAL is restored differently (see docs/deploy.md).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <dump.sql> [engine]" >&2
  exit 1
fi
DUMP="$1"
ENGINE="${2:-}"
if [[ -z "$ENGINE" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then
    ENGINE=podman
  fi
fi
[[ -n "$ENGINE" ]] || { echo "No engine." >&2; exit 1; }

PROJECT="${COMPOSE_PROJECT_NAME:-llm-quota}"
echo "[restore] engine=${ENGINE} dump=${DUMP}"

# psql restore, dropping/creating the DB first is destructive — run with care.
"$ENGINE" "$COMPOSE" -f docker/compose.yaml --project-name "$PROJECT" exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\"" \
  && psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$POSTGRES_DB\""' < /dev/null

"$ENGINE" "$COMPOSE" -f docker/compose.yaml --project-name "$PROJECT" exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$DUMP"

echo "[restore] done."
