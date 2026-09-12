/**
 * Development seed for llm-quota: creates the default quota providers so a
 * fresh database is usable. Run with `pnpm --filter @llm-quota/db seed`.
 */

import { createDb, resolveDatabaseConfig } from "./client.js";
import { quotaProviders, users } from "./schema/index.js";

/** Provider definitions registered by the seed (v1 connectors). */
export const DEFAULT_PROVIDERS = [
  { providerKey: "ollama-claude/api", name: "Ollama Claude", connectorId: "ollama-claude/api", connectionType: "api" as const },
  { providerKey: "openrouter/api", name: "OpenRouter", connectorId: "openrouter/api", connectionType: "api" as const },
];

/**
 * Seed default quota providers into a fresh database. Idempotent: rows already
 * present for a provider key + type are left untouched. Returns rows seeded.
 *
 * Bootstrap admin: when `SEED_ADMIN_EMAIL` is set, an active user with that
 * email is created (role from `SEED_ADMIN_ROLE`, default `admin`) so a fresh
 * deployment has a principal to authenticate with. Idempotent per email.
 */
export async function seed(): Promise<number> {
  const config = resolveDatabaseConfig();
  const handle = createDb(config);
  const db = handle.db;
  let seeded = 0;
  for (const p of DEFAULT_PROVIDERS) {
    await db
      .insert(quotaProviders)
      .values(p)
      .onConflictDoNothing({ target: [quotaProviders.providerKey, quotaProviders.connectionType] });
    seeded += 1;
  }
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  if (adminEmail) {
    const role = (process.env.SEED_ADMIN_ROLE ?? "admin") as "user" | "supervisor" | "admin";
    await db
      .insert(users)
      .values({ email: adminEmail, role, isActive: true })
      .onConflictDoNothing({ target: users.email });
    console.log(`seeded bootstrap admin ${adminEmail} (role=${role})`);
  }
  await handle.close();
  return seeded;
}

// Run directly when invoked via CLI.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) {
  seed()
    .then((n) => {
      console.log(`seeded ${n} provider(s)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
