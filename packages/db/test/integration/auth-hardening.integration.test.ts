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
    const first = await rotateSession(t.app.db, session.id, {
      userId,
      tokenHash: hashToken("race-new-a"),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const second = await rotateSession(t.app.db, session.id, {
      userId,
      tokenHash: hashToken("race-new-b"),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(first.rotated).toBe(true);
    expect(second.rotated).toBe(false);
  });
});
