/**
 * Development seed for llm-quota: creates the default quota providers so a
 * fresh database is usable. Run with `pnpm --filter @llm-quota/db seed`.
 */

import { createDb, resolveDatabaseConfig } from "../src/index.js";
import { quotaProviders } from "../src/schema/quotas.js";

/** Provider definitions registered by the seed (v1 connectors). */
export const DEFAULT_PROVIDERS = [
  { providerKey: "ollama-claude/api", name: "Ollama Claude", connectorId: "ollama-claude/api", connectionType: "api" as const },
  { providerKey: "openrouter/api", name: "OpenRouter", connectorId: "openrouter/api", connectionType: "api" as const },
];

/**
 * Seed default quota providers into a fresh database. Idempotent: rows already
 * present for a provider key + type are left untouched. Returns rows seeded.
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
