#!/usr/bin/env bash
# llm-quota — logical backup + PITR helper (engine-agnostic: docker OR podman).
#
# Usage:
#   ./docker/backup.sh [engine]
# where [engine] is `docker` or `podman` (default: autodetect = whichever
# `compose` command exists). Runs pg_dump against the `postgres` container
# and writes a timestamped dump to ./docker/backups/ (git-ignored).
#
# For point-in-time recovery the Postgres image persists WAL under the `pgdata`
# volume (base backup + WAL archive). See docker/restore.sh and docs/deploy.md.

set -euo pipefail

# Backups contain tenant PII, session hashes and ciphertexts: never readable
# beyond the owner (documents say: encrypt before moving offsite).
umask 077

ENGINE="${1:-}"
if [[ -z "$ENGINE" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then
    ENGINE=podman
  else
    echo "No container engine (docker/podman) found." >&2
    exit 1
  fi
fi

COMPOSE="compose"
if [[ "$ENGINE" == "podman" ]]; then COMPOSE="compose"; fi

PROJECT="${COMPOSE_PROJECT_NAME:-llm-quota}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="docker/backups"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/${PROJECT}-${STAMP}.sql"

echo "[backup] using engine=${ENGINE} -> $OUT"

# pg_dump via the postgres container (same network).
"$ENGINE" "$COMPOSE" -f docker/compose.yaml --project-name "$PROJECT" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-llmquota}" -d "${POSTGRES_DB:-llm_quota}" > "$OUT"

echo "[backup] done (logical dump). For PITR, also archive the WAL from the pgdata volume."
