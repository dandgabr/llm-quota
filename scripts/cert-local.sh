#!/usr/bin/env bash
#
# Generate a self-signed TLS certificate for LOCAL development/testing only.
#
# The certificate is written into ./certs (git-ignored) and is NEVER meant for
# production. It carries a short TTL (30 days) and a comprehensive SAN covering
# localhost + the docker-compose service names. NODE_ENV=production refuses to
# load these "local.*" files (see apps/api guard).
#
# Usage:   scripts/cert-local.sh
# Output:  certs/local.crt, certs/local.key
# Requires: openssl (3.x recommended for TLS 1.3)
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found in PATH" >&2
  exit 1
fi

if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "Refusing to generate a local self-signed cert in NODE_ENV=production." >&2
  exit 1
fi

DIR="certs"
mkdir -p "$DIR"

CERT="$DIR/local.crt"
KEY="$DIR/local.key"

openssl req -x509 -newkey rsa:3072 -nodes \
  -keyout "$KEY" \
  -out "$CERT" \
  -days 30 \
  -subj "/CN=llm-quota.local" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:web,DNS:api,DNS:postgres" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1

chmod 600 "$KEY"

echo "Generated local self-signed cert (30 days, dev-only):"
echo "  $CERT"
echo "  $KEY"
echo
echo "Set TLS_CERT_PATH=$CERT and TLS_KEY_PATH=$KEY for local test."
echo "Never deploy these files. Production uses a real CA certificate."
