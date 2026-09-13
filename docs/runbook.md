# Operations Runbook

How-to procedures for operating a deployed llm-quota stack (Docker or Podman).
Topology and profiles are documented in [deploy.md](deploy.md); the full
environment-variable reference is
[architecture/environment-variables.md](architecture/environment-variables.md).

All `docker compose` commands below have a `podman-compose` equivalent. Paths
are relative to the repository root.

---

## 1. First-run bootstrap (fresh deployment)

The `postgres` volume starts empty; migrations and the seed must run once from
the host through the loopback **ops** port (`--profile ops`).

```bash
# 1. Stack up (postgres + api + web). The API will retry until the DB is ready.
docker compose -f docker/compose.yaml --env-file docker/.env up -d --build

# 2. Temporarily publish Postgres on 127.0.0.1:${POSTGRES_OPS_PORT:-15432}
docker compose -f docker/compose.yaml --env-file docker/.env --profile ops up -d

# 3. Migrate + seed as the superuser (migrations need DDL rights).
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:15432/${POSTGRES_DB}"
pnpm --filter @llm-quota/db db:migrate
SEED_ADMIN_EMAIL=ops@example.com pnpm --filter @llm-quota/db seed

# 4. Close the ops port again.
docker compose -f docker/compose.yaml --env-file docker/.env --profile ops down
```

What the bootstrap does:

- `db:migrate` applies the versioned Drizzle migrations. Migration `0001`
  creates the non-superuser role `llmquota_app` **without a password**
  (provisioning sets it); migration `0002` adds `user_sessions.signature` and
  the collector RLS policies (`app.is_collector`).
- `seed` registers the quota providers (`antigravity/oauth`, `opencode-go/api`,
  `ollama-claude/api`, `openrouter/api`) and, when `SEED_ADMIN_EMAIL` is set,
  creates the bootstrap admin user (role from `SEED_ADMIN_ROLE`, default `admin`). Both steps are
  idempotent.

The first boot of the `postgres` container runs `docker/pg/init-prod.sh`
(mounted into `docker-entrypoint-initdb.d`), which creates `llmquota_app` with
the password from `POSTGRES_APP_PASSWORD`. This script only runs on an **empty
data volume** — later password changes are manual (§5).

Prefer `db:migrate` for every schema change. `db:push` exists but diffs the
schema live and can drift from the migration history — treat it as a
drift-dangerous last resort for throwaway databases.

## 2. Onboarding & First-run Setup Wizard

When starting a fresh instance without a seeded admin:
1. Navigating to the web app (`/`) or directly to `/setup` opens the Setup Wizard.
2. The server mints an ephemeral 256-bit bootstrap token on first boot and prints it to stdout.
3. The operator pastes the setup token, sets the administrator email and password, and completes mandatory TOTP MFA enrollment.
4. Once completed, standard login (`POST /auth/login`) is active and `/setup` locks permanently (`409 Conflict`).

During testing/dev, `POST /auth/issue-session` remains available under `ENABLE_DEV_SESSION=1` and `NODE_ENV!=production`.

```bash
# Requires ENABLE_DEV_SESSION=1 and NODE_ENV != production (fail-closed otherwise).
curl -X POST http://localhost:3000/auth/issue-session \
  -H 'Content-Type: application/json' \
  -d '{"userId":"<user-uuid>","role":"admin","expiresInSec":3600}'
# -> { "token": "...", "expiresAt": "..." }
```

- `expiresInSec` is capped at 24 h regardless of the requested value.
- `userId` is the `users.id` UUID: `SELECT id, email, role FROM users;`
  (through the ops port in a prod-shaped stack).
- The SPA login view accepts this token and sends it as
  `Authorization: Bearer <token>`.
- The OIDC challenge (`/auth/oidc/authorize`) and MFA challenge endpoints
  (`/auth/mfa/{totp,webauthn}/challenge`) are gated by the same flag and return
  `403 problem+json` when disabled.

## 3. Backup and restore

```bash
# Logical dump of the whole cluster (runs pg_dump inside the stack).
docker/backup.sh          # writes docker/backups/<project>-<timestamp>.sql (umask 077)

# Restore a dump. DESTRUCTIVE: drops and recreates the target database first.
docker/restore.sh docker/backups/<project>-<timestamp>.sql
```

- Output files are named `<project>-<timestamp>.sql` (project defaults to
  `llm-quota`, overridable via `COMPOSE_PROJECT_NAME`).
- `docker/backups/` is git-ignored; backups contain tenant PII, session hashes
  and ciphertexts — keep copies **off-host** (encrypt before moving them).
- `backup.sh` uses the superuser credentials from the stack environment and
  autodetects the engine (`docker` or `podman`; pass either as the optional
  argument).
- `restore.sh` **drops and recreates** the database before replaying the dump —
  never point it at a stack whose live data you want to keep.
- Restore-test periodically: bring up a scratch stack with an empty volume and
  run `restore.sh` against it before you ever need it for real.

## 4. Point-in-time recovery (PITR) note

WAL segments live **inside the `pgdata` volume**; the shipped stack does not
archive WAL off-host. Consequences:

- The logical dumps from §3 protect against data loss but **do not** enable
  point-in-time recovery by themselves.
- For PITR, take a volume-level snapshot (or filesystem copy while Postgres is
  quiesced) of `pgdata` as the base backup and keep it together with the WAL
  that accumulated afterwards, on separate storage.
- Enabling continuous WAL archiving to off-host storage is a hardening backlog
  item; until then, recovery granularity is "last backup + last volume
  snapshot".

## 5. Rotating the `llmquota_app` password

`init-prod.sh` only provisions the role on an empty volume, so rotation is
manual SQL through the ops port:

```bash
docker compose -f docker/compose.yaml --env-file docker/.env --profile ops up -d

# Rotate in the database (superuser connection):
psql "postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:15432/${POSTGRES_DB}" \
  -c "ALTER ROLE llmquota_app PASSWORD '<new-random-password>';"

# Update the compose secret and recreate only the api service:
#   docker/.env -> POSTGRES_APP_PASSWORD=<new-random-password>
docker compose -f docker/compose.yaml --env-file docker/.env up -d --force-recreate api

docker compose -f docker/compose.yaml --env-file docker/.env --profile ops down
```

The API pool reconnects with the new password on recreation; RLS behavior is
unchanged (the role identity, not the password, carries the grants).

## 6. KEK rotation (envelope encryption, concept)

Connection secrets are sealed as
`v1.<secretNonce>.<secretAuthTag>.<secretCiphertext>.<wrapNonce>.<wrappedDek>`
(AES-256-GCM; a per-secret 32-byte DEK wrapped by the KEK). The KEK exists
only in the `LLM_QUOTA_KEK` environment variable — never in the database —
and there is a single active KEK per deployment; the `v1` prefix identifies
the payload **format**, not the key.

Rotation procedure (concept — no built-in tool today):

1. Generate a new key: `openssl rand -base64 32`.
2. With **both** keys available, decrypt every sealed secret with the old KEK
   and re-seal it with the new one (re-wraps each DEK), writing new `v1.…`
   payloads back to `connections.secret_cipher`. The table holding sealed
   secrets is the full rotation surface.
3. Swap `LLM_QUOTA_KEK` in `docker/.env` / the process env and restart `api`.
4. Verify: `GET /v1/connections` still returns every connection and a collect
   pass succeeds (the collector decrypts secrets to call the providers).

Decryption with the wrong KEK throws — a failed rotation is loud, not silent.

## 7. Collector tuning

The collector is a scheduler **inside the `api` process** — no sidecar, no
cron. Environment (set on the `api` service / compose env):

| Variable             | Default | Meaning                                                       |
| -------------------- | ------- | ------------------------------------------------------------- |
| `COLLECT_INTERVAL_MS`| `60000` | Poll interval. First pass runs ~5 s after boot. `0` disables. |

Behavior worth knowing before tuning:

- Enumeration is cross-tenant via the `app.is_collector` RLS policy; writes
  happen per owner under a per-user RLS context (`withRlsContext`).
- Raw `quota_snapshots` have a 7-day TTL; `spending_aggregates` are evicted
  after 12 months.
- Only real usage (`used`) is booked into aggregates — balance-only credit
  snapshots never inflate spend.

Lowering the interval increases provider API traffic and DB writes roughly
linearly; there is no per-connection backoff configuration yet.

## 8. Known limitations & Backlog (operational)

- **External Enterprise SSO** — Local authentication (passwords, TOTP MFA, recovery codes) is active and enforced. External OIDC SSO federation and SCIM are reserved for future phases. Dev-only session endpoints fail closed outside development.
- **Bearer token in `localStorage`** — XSS trade-off, mitigated by the edge
  CSP (`default-src 'self'`). No HttpOnly cookies exist today; browser
  sessions end when the token expires or is revoked via `DELETE /v1/sessions/:id`.
- **Rate limiter is in-process** — the 30 req/min per-IP limiter on `/auth/*`
  is per API instance; horizontal scaling would multiply the budget (the edge
  `limit_req` remains global).
- **No WAL archiving off-host** — see §4.
- **`db:push` is drift-dangerous** — use `db:migrate` (§1).
