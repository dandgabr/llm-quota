#!/usr/bin/env bash
#
# Generate a self-signed TLS certificate for the Postgres service (H4).
#
# The certificate is the CA the api trusts AND the server cert Postgres
# presents, so the api can connect with sslmode=verify-full. Written into
# ./certs (git-ignored). Local/dev only; production should use a real CA.
#
# Usage:   scripts/cert-postgres.sh
# Output:  certs/postgres.crt, certs/postgres.key
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found in PATH" >&2
  exit 1
fi

DIR="certs"
mkdir -p "$DIR"
CRT="$DIR/postgres.crt"
KEY="$DIR/postgres.key"

openssl req -x509 -newkey rsa:3072 -nodes \
  -keyout "$KEY" \
  -out "$CRT" \
  -days 3650 \
  -subj "/CN=postgres" \
  -addext "subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1

chmod 600 "$KEY"
echo "wrote $CRT and $KEY"
