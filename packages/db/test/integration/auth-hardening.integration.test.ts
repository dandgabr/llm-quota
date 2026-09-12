/**
 * E4/E5 integration tests (app-role, adversarial): durable login throttle and
 * session idle/rotation under the non-superuser pool.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { hashToken } from "@llm-quota/auth";
import { resetDatabase, seedUser, setupTestDb, type TestDb } from "../helpers/db.js";
import { PostgresAuthStore } from "../../src/repositories/auth.js";
import {
  createSession,
  resolvePrincipal,
  rotateSession,
  withRlsContext,
} from "../../src/repositories/sessions.js";

let t: TestDb;

beforeAll(async () => {
  t = await setupTestDb({ migrate: true });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDatabase(t.super);
});

const THROTTLE = { threshold: 3, windowSeconds: 900, baseSeconds: 30, maxSeconds: 3600 };
const owner = (userId: string) => ({ userId, role: "user" as const, isAdmin: false, isSupervisorAdmin: false });

describe("E4 — durable login throttle", () => {
  it("locks after the threshold and unlocks only via reset", async () => {
    const store = new PostgresAuthStore(t.app.db, t.kek);
    const subject = "a".repeat(64);
    const ip = "b".repeat(64);
    for (let i = 0; i < 3; i++) {
      await t.app.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
        await store.recordLoginFailure(subject, ip, THROTTLE, { db: tx });
      });
    }
    const row = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
      return store.getLoginAttempt(subject, ip, { db: tx });
    });
    expect(row?.failedCount).toBe(3);
    expect(row?.lockedUntil).not.toBeNull();
    // Reset clears the throttle (successful login).
    await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
      await store.resetLoginAttempts(subject, { db: tx });
    });
    const after = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
      return store.getLoginAttempt(subject, ip, { db: tx });
    });
    expect(after).toBeNull();
  });

  it("the throttle table is invisible without the purpose GUC", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "thr@test.local" });
    const store = new PostgresAuthStore(t.app.db, t.kek);
    await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
      await store.recordLoginFailure("x".repeat(64), "", THROTTLE, { db: tx });
    });
    const blind = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      return store.getLoginAttempt("x".repeat(64), "", { db: tx });
    });
    expect(blind).toBeNull();
  });
});

describe("E5 — session idle + rotation", () => {
  it("rejects an idle session while its absolute expiry is still in the future", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "idle@test.local" });
    const token = "idle-token-123456";
    await withRlsContext(t.app.db, owner(userId), (tx) =>
      createSession(tx, {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 12 * 3600_000),
        lastSeenAt: new Date(Date.now() - 3600_000),
        stepUpAt: null,
      }),
    );
    // idle TTL 30 min: a session last seen 1h ago is rejected.
    const principal = await resolvePrincipal(t.app.db, token, new Date(), undefined, {
      idleTtlSeconds: 1800,
    });
    expect(principal).toBeNull();
  });

  it("resolves a fresh session and reveals stepUpAt", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "fresh@test.local" });
    const token = "fresh-token-123456";
    const stepUpAt = new Date();
    await withRlsContext(t.app.db, owner(userId), (tx) =>
      createSession(tx, {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 12 * 3600_000),
        lastSeenAt: new Date(),
        stepUpAt,
      }),
    );
    const principal = await resolvePrincipal(t.app.db, token, new Date(), undefined, {
      idleTtlSeconds: 1800,
    });
    expect(principal?.userId).toBe(userId);
    expect(principal?.stepUpAt?.getTime()).toBe(stepUpAt.getTime());
  });

  it("rotation revokes the old session and rejects it afterwards", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "rot@test.local" });
    const oldToken = "rot-old-token-12345";
    const session = await withRlsContext(t.app.db, owner(userId), (tx) =>
      createSession(tx, {
        userId,
        tokenHash: hashToken(oldToken),
        expiresAt: new Date(Date.now() + 3600_000),
        lastSeenAt: new Date(),
      }),
    );
    const newToken = "rot-new-token-12345";
    const rotated = await rotateSession(t.app.db, session.id, {
      userId,
      tokenHash: hashToken(newToken),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(rotated.rotated).toBe(true);
    expect(await resolvePrincipal(t.app.db, oldToken)).toBeNull();
    expect((await resolvePrincipal(t.app.db, newToken))?.userId).toBe(userId);
  });

  it("a second concurrent rotation of the same session loses (atomic gate)", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "race@test.local" });
    const token = "race-old-token-1234";
    const session = await withRlsContext(t.app.db, owner(userId), (tx) =>
      createSession(tx, {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600_000),
        lastSeenAt: new Date(),
      }),
    );
    // Truly concurrent: only one update may win the revoked=false gate.
    const [first, second] = await Promise.all([
      rotateSession(t.app.db, session.id, {
        userId,
        tokenHash: hashToken("race-new-a"),
        expiresAt: new Date(Date.now() + 3600_000),
      }),
      rotateSession(t.app.db, session.id, {
        userId,
        tokenHash: hashToken("race-new-b"),
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    ]);
    expect([first.rotated, second.rotated].filter(Boolean)).toHaveLength(1);
  });

  it("touches last_seen_at on a successful resolve (throttled write)", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "touch@test.local" });
    const token = "touch-token-123456";
    const before = new Date(Date.now() - 10 * 60_000);
    await withRlsContext(t.app.db, owner(userId), (tx) =>
      createSession(tx, {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600_000),
        lastSeenAt: before,
      }),
    );
    await resolvePrincipal(t.app.db, token, new Date(), undefined, { touchIntervalSeconds: 60 });
    const [row] = await t.super.db
      .execute<{ last_seen_at: string }>(sql`SELECT last_seen_at FROM user_sessions WHERE token_hash = ${hashToken(token)}`)
      .then((r) => r.rows);
    expect(new Date(row!.last_seen_at).getTime()).toBeGreaterThan(before.getTime());
  });

  it("does NOT touch last_seen_at when the account is blocked (invariant)", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "blocked@test.local" });
    const token = "blocked-token-1234";
    const before = new Date(Date.now() - 10 * 60_000);
    await withRlsContext(t.app.db, owner(userId), (tx) =>
      createSession(tx, {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600_000),
        lastSeenAt: before,
      }),
    );
    await t.super.db.execute(sql`UPDATE users SET is_active = false WHERE id = ${userId}`);
    const principal = await resolvePrincipal(t.app.db, token, new Date(), undefined, { touchIntervalSeconds: 60 });
    expect(principal).toBeNull();
    const [row] = await t.super.db
      .execute<{ last_seen_at: string }>(sql`SELECT last_seen_at FROM user_sessions WHERE token_hash = ${hashToken(token)}`)
      .then((r) => r.rows);
    expect(new Date(row!.last_seen_at).getTime()).toBe(before.getTime());
  });

  it("H1: the account-global bucket never hard-locks; it counts for the soft delay", async () => {
    const store = new PostgresAuthStore(t.app.db, t.kek);
    const subject = "c".repeat(64);
    // 60 account-global failures across the window: the count grows...
    let count = 0;
    for (let i = 0; i < 60; i++) {
      await t.app.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
        count = await store.recordAccountFailure(subject, 900, { db: tx });
      });
    }
    expect(count).toBe(60);
    // ...but the (subject, ip) bucket is untouched: no lock is ever set.
    const ipRow = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
      return store.getLoginAttempt(subject, "d".repeat(64), { db: tx });
    });
    expect(ipRow).toBeNull();
    // The account bucket never produces a lock.
    const accountRow = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
      return store.getLoginAttempt(subject, "", { db: tx });
    });
    expect(accountRow?.lockedUntil ?? null).toBeNull();
    // Success clears both buckets.
    await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
      await store.resetLoginAttempts(subject, { db: tx });
    });
    const cleared = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_auth_throttle', 'true', true)`);
      return store.getLoginAttempt(subject, "", { db: tx });
    });
    expect(cleared).toBeNull();
  });

  it("H2: a rotated session within grace is accepted; outside grace rejected", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "grace@test.local" });
    const oldToken = "grace-old-token-1";
    const session = await withRlsContext(t.app.db, owner(userId), (tx) =>
      createSession(tx, {
        userId,
        tokenHash: hashToken(oldToken),
        expiresAt: new Date(Date.now() + 3600_000),
        lastSeenAt: new Date(),
      }),
    );
    // Rotate WITHOUT immediate (periodic mode): old token keeps grace.
    const rotated = await rotateSession(t.app.db, session.id, {
      userId,
      tokenHash: hashToken("grace-new-token-1"),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(rotated.rotated).toBe(true);
    // Within the grace window the old token still resolves.
    const within = await resolvePrincipal(t.app.db, oldToken, new Date(), undefined, {
      graceSeconds: 60,
    });
    expect(within?.userId).toBe(userId);
    // Outside the grace window it is rejected.
    const later = new Date(Date.now() + 61_000);
    const outside = await resolvePrincipal(t.app.db, oldToken, later, undefined, {
      graceSeconds: 60,
    });
    expect(outside).toBeNull();
    // The new token always resolves.
    expect(
      (await resolvePrincipal(t.app.db, "grace-new-token-1", later, undefined, { graceSeconds: 60 }))
        ?.userId,
    ).toBe(userId);
  });
});
