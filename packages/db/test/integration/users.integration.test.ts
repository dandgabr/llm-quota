/**
 * Phase A integration tests: user management under the app-role pool.
 *
 * These are ADVERSARIAL: they run as `llmquota_app` (non-superuser, FORCE RLS)
 * so a missing GUC/policy fails here instead of only in production. They prove
 * the anti-escalation trigger, first-admin/invite authorizers, soft-delete
 * rejection and idempotency ledger behaviour.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { hashToken } from "@llm-quota/auth";
import {
  resetDatabase,
  seedUser,
  setupTestDb,
  type TestDb,
} from "../helpers/db.js";
import { PostgresUserStore } from "../../src/repositories/users.js";
import { PostgresInviteStore } from "../../src/repositories/invites.js";
import { PostgresIdempotencyStore } from "../../src/repositories/idempotency.js";
import { withRlsContext, resolvePrincipal, createSession } from "../../src/repositories/sessions.js";
import { issueSessionToken } from "@llm-quota/auth";
import { users } from "../../src/schema/auth.js";

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

const adminPrincipal = (id: string) => ({
  userId: id,
  role: "admin" as const,
  isAdmin: true,
  isSupervisorAdmin: true,
});

describe("Phase A — user management RLS", () => {
  it("admin can list live users through the app-role pool", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "admin@test.local" });
    await seedUser(t.super, { role: "user", email: "u@test.local" });
    await seedUser(t.super, { role: "user", email: "gone@test.local" });
    await t.super.db.execute(sql`UPDATE users SET deleted_at = now() WHERE email = 'gone@test.local'`);

    const rows = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresUserStore(tx).list({ db: tx }),
      { "app.users_admin_write": "true" },
    );
    expect(rows.map((r) => r.email).sort()).toEqual(["admin@test.local", "u@test.local"]);
  });

  it("non-admin cannot escalate their own role (trigger + RLS deny)", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "victim@test.local" });
    // No app.users_admin_write GUC -> the anti-escalation trigger raises and,
    // had it not, users_admin_update has no matching policy (defense in depth).
    await expect(
      t.app.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
        return tx
          .update(users)
          .set({ role: "admin" })
          .where(eq(users.id, userId))
          .returning({ id: users.id });
      }),
    ).rejects.toThrow();
    const [row] = await t.super.db.execute<{ role: string }>(
      sql`SELECT role FROM users WHERE id = ${userId}`,
    ).then((r) => r.rows);
    expect(row?.role).toBe("user");
  });

  it("resolvePrincipal rejects soft-deleted users", async () => {
    const userId = await seedUser(t.super, { role: "user", email: "sd@test.local" });
    const { token, hash, signature } = issueSessionToken(t.sessionSecret);
    await withRlsContext(t.app.db, { userId, role: "user", isAdmin: false, isSupervisorAdmin: false }, (tx) =>
      createSession(tx, { userId, tokenHash: hash, signature, expiresAt: new Date(Date.now() + 3600_000) }),
    );
    // Soft delete + revoke sessions (as the store does).
    await withRlsContext(
      t.app.db,
      adminPrincipal(userId),
      (tx) => new PostgresUserStore(tx).softDelete(userId, { db: tx }),
      { "app.users_admin_write": "true" },
    );
    const principal = await resolvePrincipal(t.app.db, token, new Date(), t.sessionSecret);
    expect(principal).toBeNull();
  });

  it("invite accept path is invisible without app.is_invite", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "a2@test.local" });
    const tokenHash = hashToken("invite-raw-token");
    await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) =>
        new PostgresInviteStore(tx).create(
          { email: "new@test.local", role: "user", tokenHash, expiresAt: new Date(Date.now() + 3600_000), invitedBy: adminId },
          { db: tx },
        ),
      { "app.users_admin_write": "true" },
    );
    // Without the pre-auth GUC the invite is not visible to the app role.
    const blind = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${adminId}, true)`);
      return new PostgresInviteStore(tx).findLiveByTokenHash(tokenHash, { db: tx });
    });
    expect(blind).toBeNull();
    // With app.is_invite, it resolves.
    const found = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.is_invite', 'true', true)`);
      return new PostgresInviteStore(tx).findLiveByTokenHash(tokenHash, { db: tx });
    });
    expect(found?.email).toBe("new@test.local");
  });

  it("idempotency claim is owner-scoped and replays the stored response", async () => {
    const a = await seedUser(t.super, { role: "admin", email: "id-a@test.local" });
    const b = await seedUser(t.super, { role: "admin", email: "id-b@test.local" });
    const hash = "a".repeat(64);
    await withRlsContext(t.app.db, adminPrincipal(a), async (tx) => {
      const store = new PostgresIdempotencyStore(tx);
      const first = await store.claim(a, "key-12345678", hash, 3600, { db: tx });
      expect(first.kind).toBe("claimed");
      await store.complete(a, "key-12345678", 201, JSON.stringify({ ok: true }), { db: tx });
      const replay = await store.claim(a, "key-12345678", hash, 3600, { db: tx });
      expect(replay.kind).toBe("replay");
      expect(replay.status).toBe(201);
    }, { "app.users_admin_write": "true" });
    // A different user cannot see user A's idempotency row.
    const hidden = await withRlsContext(t.app.db, adminPrincipal(b), (tx) =>
      new PostgresIdempotencyStore(tx).claim(b, "key-12345678", hash, 3600, { db: tx }),
      { "app.users_admin_write": "true" },
    );
    expect(hidden.kind).toBe("claimed");
  });

  it("soft delete revokes the user's sessions", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "adm-sd@test.local" });
    const target = await seedUser(t.super, { role: "user", email: "t-sd@test.local" });
    const other = await seedUser(t.super, { role: "user", email: "other-sd@test.local" });
    const { hash } = issueSessionToken(t.sessionSecret);
    await withRlsContext(t.app.db, { userId: target, role: "user", isAdmin: false, isSupervisorAdmin: false }, (tx) =>
      createSession(tx, { userId: target, tokenHash: `${hash}-a`, expiresAt: new Date(Date.now() + 3600_000) }),
    );
    await withRlsContext(t.app.db, { userId: target, role: "user", isAdmin: false, isSupervisorAdmin: false }, (tx) =>
      createSession(tx, { userId: target, tokenHash: `${hash}-b`, expiresAt: new Date(Date.now() + 3600_000) }),
    );
    await withRlsContext(t.app.db, { userId: other, role: "user", isAdmin: false, isSupervisorAdmin: false }, (tx) =>
      createSession(tx, { userId: other, tokenHash: `${hash}-c`, expiresAt: new Date(Date.now() + 3600_000) }),
    );
    await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresUserStore(tx).softDelete(target, { db: tx }),
      { "app.users_admin_write": "true" },
    );
    const rows = await t.super.db
      .execute<{ user_id: string; revoked: boolean }>(
        sql`SELECT user_id, revoked FROM user_sessions ORDER BY token_hash`,
      )
      .then((r) => r.rows);
    const targetRows = rows.filter((r) => r.user_id === target);
    expect(targetRows).toHaveLength(2);
    expect(targetRows.every((r) => r.revoked)).toBe(true);
    expect(rows.find((r) => r.user_id === other)?.revoked).toBe(false);
  });

  it("a pure supervisor can read users; the supervisor policy hides soft-deleted", async () => {
    const supId = await seedUser(t.super, { role: "supervisor", email: "sup@test.local" });
    await seedUser(t.super, { role: "user", email: "live@test.local" });
    await seedUser(t.super, { role: "user", email: "dead@test.local" });
    await t.super.db.execute(sql`UPDATE users SET deleted_at = now() WHERE email = 'dead@test.local'`);
    const rows = await withRlsContext(
      t.app.db,
      { userId: supId, role: "supervisor", isAdmin: false, isSupervisorAdmin: true },
      (tx) => new PostgresUserStore(tx).list({ db: tx }),
      { "app.is_supervisor_admin": "true" },
    );
    const emails = rows.map((r) => r.email).sort();
    expect(emails).toContain("live@test.local");
    expect(emails).not.toContain("dead@test.local");
  });

  it("admin can hard-delete a user (users_admin_delete policy) only with the write GUC", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "del-admin@test.local" });
    const target = await seedUser(t.super, { role: "user", email: "hard-del@test.local" });
    // Without the GUC: 0 rows (no matching policy).
    const blind = await t.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${adminId}, true)`);
      return tx.delete(users).where(eq(users.id, target)).returning({ id: users.id });
    });
    expect(blind).toHaveLength(0);
    // With the GUC: the row is removed.
    const deleted = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => tx.delete(users).where(eq(users.id, target)).returning({ id: users.id }),
      { "app.users_admin_write": "true" },
    );
    expect(deleted).toHaveLength(1);
  });

  it("findByEmail resolves over the app role only for the target email", async () => {
    const { hashPassword } = await import("@llm-quota/auth");
    const passwordHash = await hashPassword("seed-password-123");
    await seedUser(t.super, { role: "user", email: "lookup@test.local", passwordHash });
    const found = await withRlsContext(
      t.app.db,
      { userId: "", role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => new PostgresUserStore(tx).findByEmail("lookup@test.local", { db: tx }),
      { "app.is_auth": "true", "app.auth_email": "lookup@test.local" },
    );
    expect(found?.email).toBe("lookup@test.local");
    expect(found?.passwordHash).toContain("$scrypt$");
  });

  it("F1: anonymize scrubs PII, credentials and MFA, keeping the id", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "anon-admin@test.local" });
    const target = await seedUser(t.super, {
      role: "user",
      email: "anon-target@test.local",
      passwordHash: "scrypt$placeholder",
    });
    const ok = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresUserStore(tx).anonymize(target, { db: tx }),
      { "app.users_admin_write": "true" },
    );
    expect(ok).toBe(true);
    const [row] = await t.super.db
      .execute<{ email: string; fname: string | null; anon: string | null; creds: number }>(
        sql`SELECT u.email, u.first_name AS fname, u.anonymized_at AS anon,
              (SELECT count(*)::int FROM user_credentials c WHERE c.user_id = u.id) AS creds
            FROM users u WHERE u.id = ${target}`,
      )
      .then((r) => r.rows);
    expect(row?.email).toBe(`deleted+${target}@invalid.local`);
    expect(row?.fname).toBeNull();
    expect(row?.anon).not.toBeNull();
    expect(row?.creds).toBe(0);
  });

  it("F1: anonymize is idempotent (second call returns false)", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "anon2-admin@test.local" });
    const target = await seedUser(t.super, { role: "user", email: "anon2@test.local" });
    const first = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresUserStore(tx).anonymize(target, { db: tx }),
      { "app.users_admin_write": "true" },
    );
    const second = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresUserStore(tx).anonymize(target, { db: tx }),
      { "app.users_admin_write": "true" },
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
