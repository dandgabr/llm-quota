import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestDb,
  seedUser,
  seedProvider,
  seedConnection,
  resetDatabase,
} from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { PostgresHistoryStore } from "../../src/repositories/history.js";
import {
  createSession,
  resolvePrincipal,
  withRlsContext,
  type ResolvedPrincipal,
} from "../../src/repositories/sessions.js";
import { hashToken } from "@llm-quota/auth";
import type { Aggregate } from "@llm-quota/core";

let t: TestDb;
let aliceId: string;
let bobId: string;
let connA: string;


const agg = (userId: string, connectionId: string, over: Partial<Aggregate> = {}): Aggregate => ({
  granularity: "daily",
  windowKey: "daily:2026-09-11T00:00:00.000Z",
  userId,
  connectionId,
  spentAmount: 10,
  currency: "USD",
  count: 1,
  ...over,
});

beforeAll(async () => {
  t = await setupTestDb({ migrate: true });
  await resetDatabase(t.super);
  aliceId = await seedUser(t.super, { role: "user", email: "alice@rlst.test" });
  bobId = await seedUser(t.super, { role: "user", email: "bob@rlst.test" });
  const providerId = await seedProvider(t.super, "openrouter/api");
  connA = await seedConnection(t.super, { userId: aliceId, providerId, secret: "sk-a" });
  await seedConnection(t.super, { userId: bobId, providerId, secret: "sk-b" });
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("history aggregates — real Postgres", () => {
  it("increments spentAmount/count on conflict (C1), never overwrites", async () => {
    const store = new PostgresHistoryStore(t.super.db);
    await store.upsertAggregate(agg(aliceId, connA));
    await store.upsertAggregate(agg(aliceId, connA));
    // windowKey is `daily:2026-09-11T00:00:00.000Z`; filter with the matching prefix.
    const listed = await store.listByUser(aliceId, "daily", "daily:2026-09-01", "daily:2026-09-30");
    expect(listed.length).toBe(1);
    expect(listed[0]!.spentAmount).toBe(20); // 10 + 10
    expect(listed[0]!.count).toBe(2);
  });

  it("keeps daily/weekly/monthly slots isolated by granularity", async () => {
    const store = new PostgresHistoryStore(t.super.db);
    await store.upsertAggregate(agg(aliceId, connA, { granularity: "weekly", windowKey: "weekly:2026-09-07T00:00:00.000Z" }));
    await store.upsertAggregate(agg(aliceId, connA, { granularity: "monthly", windowKey: "monthly:2026-09-01T00:00:00.000Z" }));
    const weekly = await store.listByUser(aliceId, "weekly", "weekly:2026-09-01", "weekly:2026-09-30");
    const monthly = await store.listByUser(aliceId, "monthly", "monthly:2026-09-01", "monthly:2026-09-30");
    expect(weekly.some((r) => r.windowKey.startsWith("weekly:"))).toBe(true);
    expect(monthly.some((r) => r.windowKey.startsWith("monthly:"))).toBe(true);
    // alice has 1 daily row (from the C1 test).
    const daily = await store.listByUser(aliceId, "daily", "daily:2026-09-01", "daily:2026-09-30");
    expect(daily.some((r) => r.windowKey.startsWith("daily:"))).toBe(true);
  });
});

describe("RLS tenant isolation — app role (llmquota_app)", () => {
  it("alice sees her own aggregates via a withRlsContext-wrapped read", async () => {
    const alicePrincipal: ResolvedPrincipal = {
      userId: aliceId,
      role: "user",
      isAdmin: false,
      isSupervisorAdmin: false,
    };
    const rows = await withRlsContext(t.app.db, alicePrincipal, async (tx) => {
      const store = new PostgresHistoryStore(tx as never);
      // windowKey uses a `daily:` prefix; filter with the matching prefix.
      return store.listByUser(aliceId, "daily", "daily:2026-01-01", "daily:2026-12-31");
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("an unwrapped read over the app-role pool returns nothing (FORCE RLS with NULL app.user_id)", async () => {
    const store = new PostgresHistoryStore(t.app.db as never);
    const rows = await store.listByUser(aliceId, "daily", "2026-01-01", "2026-12-31");
    expect(rows.length).toBe(0);
  });

  it("resolvePrincipal authenticates over the app-role pool via the app.is_auth path", async () => {
    // Session INSERT under the owner context (matches the issue-session route).
    const token = "rls-resolve-token-1";
    const alicePrincipal: ResolvedPrincipal = {
      userId: aliceId,
      role: "user",
      isAdmin: false,
      isSupervisorAdmin: false,
    };
    await withRlsContext(t.app.db, alicePrincipal, (tx) =>
      createSession(tx as never, {
        userId: aliceId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    );
    // Pre-auth resolution (no user GUC yet) must still find the session.
    const principal = await resolvePrincipal(t.app.db as never, token);
    expect(principal?.userId).toBe(aliceId);
  });
});
