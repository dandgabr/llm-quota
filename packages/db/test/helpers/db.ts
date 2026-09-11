/**
 * Phase 8 integration-test DB harness (real Postgres via docker/podman).
 *
 * Provides two handles with a clear role separation so RLS is truly exercised:
 *  - `super`: cluster superuser — runs migrations + seed, BYPASSES RLS.
 *  - `app`:   llmquota_app (non-superuser) — subject to FORCE RLS (tenant
 *             isolation proofs) and the app-role pool under test.
 *
 * Env used:
 *  DATABASE_MAIN_URL  (superuser; migrate/seed)
 *  DATABASE_APP_URL   (llmquota_app; app-role assertions)
 * If unset, defaults to the docker/compose.test.yaml endpoints.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "../../src/client.js";
import { users } from "../../src/schema/auth.js";
import { connections } from "../../src/schema/quotas.js";
import { userSessions } from "../../src/schema/history.js";
import { quotaProviders } from "../../src/schema/quotas.js";
import { encryptSecret } from "@llm-quota/core";

export const TEST_KEK = Buffer.alloc(32, 1); // deterministic envelope key
export const TEST_SESSION_SECRET = "s".repeat(32);

const SUPER_URL =
  process.env.DATABASE_MAIN_URL ?? "postgres://llmquota:llmquota-test@127.0.0.1:55432/llm_quota_test";
const APP_URL =
  process.env.DATABASE_APP_URL ?? "postgres://llmquota_app:llmquota-app-test@127.0.0.1:55432/llm_quota_test";

export interface TestDb {
  super: DbHandle;
  app: DbHandle;
  kek: Buffer;
  sessionSecret: string;
  /** Close both pools. */
  close(): Promise<void>;
}

/** Open both handles and (optionally) migrate + seed a fresh schema. */
export async function setupTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const superH = createDb({ url: SUPER_URL });
  const appH = createDb({ url: APP_URL });
  if (opts.migrate) {
    // Helper lives at packages/db/test/helpers; migrations at packages/db/drizzle.
    const here = dirname(fileURLToPath(import.meta.url)); // .../test/helpers
    const migrationsFolder = join(here, "..", "..", "drizzle"); // .../db/drizzle
    await migrate(superH.db, { migrationsFolder });
  }
  return {
    super: superH,
    app: appH,
    kek: TEST_KEK,
    sessionSecret: TEST_SESSION_SECRET,
    close: async () => {
      await superH.close();
      await appH.close();
    },
  };
}

/** Truncate tenant + reference tables (via superuser) so suites are hermetically independent. */
export async function resetDatabase(superH: DbHandle): Promise<void> {
  await superH.db.execute(sql`
    TRUNCATE TABLE user_sessions, spending_aggregates, quota_snapshots, quota_sessions,
      connections, quota_providers, totp_secrets, webauthn_credentials, users RESTART IDENTITY CASCADE
  `);
}

/** Insert a user via the superuser handle (bypasses RLS). Returns the user id. */
export async function seedUser(
  superH: DbHandle,
  input: { role?: "user" | "supervisor" | "admin"; email?: string },
): Promise<string> {
  const email = input.email ?? `${input.role ?? "user"}-${Date.now()}@test.local`;
  const [row] = await superH.db
    .insert(users)
    .values({
      email,
      role: input.role ?? "user",
      locale: "en",
      isActive: true,
    })
    .returning({ id: users.id });
  if (!row) throw new Error("seedUser failed");
  return row.id;
}

/** Seed a quota_provider (via superuser) and return its uuid id. */
export async function seedProvider(superH: DbHandle, key = "ollama-claude/api"): Promise<string> {
  const [row] = await superH.db
    .insert(quotaProviders)
    .values({
      providerKey: key,
      name: key,
      connectorId: key,
      connectionType: "api",
      enabled: true,
    })
    .returning({ id: quotaProviders.id });
  if (!row) throw new Error("seedProvider failed");
  return row.id;
}

/** Seed a connection row with an envelope-sealed secret (via superuser). */
export async function seedConnection(
  superH: DbHandle,
  input: { userId: string; providerId: string; label?: string; secret?: string },
): Promise<string> {
  const cipher = encryptSecret(input.secret ?? "sk-test", TEST_KEK);
  const [row] = await superH.db
    .insert(connections)
    .values({
      userId: input.userId,
      providerId: input.providerId,
      label: input.label ?? "test",
      connectionType: "api",
      secretCipher: cipher,
    })
    .returning({ id: connections.id });
  if (!row) throw new Error("seedConnection failed");
  return row.id;
}

/** Insert a user_session row (superuser). Returns the token hash + expiresAt. */
export async function seedSession(
  superH: DbHandle,
  input: { userId: string; expiresAt?: Date; revoked?: boolean },
): Promise<{ id: string; tokenHash: string }> {
  const tokenHash = "h".repeat(64); // deterministic placeholder
  const [row] = await superH.db
    .insert(userSessions)
    .values({
      userId: input.userId,
      tokenHash: `${tokenHash}-${input.userId}`,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 3600_000),
      revoked: input.revoked ?? false,
    })
    .returning({ id: userSessions.id, tokenHash: userSessions.tokenHash });
  if (!row) throw new Error("seedSession failed");
  return row;
}
