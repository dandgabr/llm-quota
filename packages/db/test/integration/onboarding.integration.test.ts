/**
 * Phase C onboarding integration tests (app-role, adversarial).
 *
 * Proves the first-run bootstrap requires the token (a bare GUC cannot create
 * an admin), is single-use, and that invite accept is atomic and email-bound.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { hashToken, hashPassword } from "@llm-quota/auth";
import { resetDatabase, seedUser, setupTestDb, type TestDb } from "../helpers/db.js";
import { PostgresInstanceStore } from "../../src/repositories/instance.js";
import { PostgresInviteStore } from "../../src/repositories/invites.js";
import { withRlsContext } from "../../src/repositories/sessions.js";
import { issueInviteToken } from "@llm-quota/auth";

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

describe("Phase C — onboarding", () => {
  it("setupRequired reflects instance state; bootstrap token is single-use", async () => {
    const store = new PostgresInstanceStore(t.app.db);
    expect(await store.setupRequired()).toBe(true);
    const raw = "bootstrap-raw-token-1234567890";
    expect(await store.beginBootstrap(hashToken(raw), new Date(Date.now() + 60_000))).toBe(true);
    const passwordHash = await hashPassword("first-admin-pass-123");
    const id = await store.createFirstAdmin({
      tokenHash: hashToken(raw),
      email: "owner@test.local",
      passwordHash,
    });
    expect(id).toBeTruthy();
    // Second attempt reuses the token -> NULL (single-use, setup now complete).
    expect(
      await store.createFirstAdmin({
        tokenHash: hashToken(raw),
        email: "second@test.local",
        passwordHash,
      }),
    ).toBeNull();
    expect(await store.setupRequired()).toBe(false);
  });

  it("the first admin created by setup is an admin with a stored credential", async () => {
    const store = new PostgresInstanceStore(t.app.db);
    const raw = "valid-bootstrap-token-abcdef";
    await store.beginBootstrap(hashToken(raw), new Date(Date.now() + 60_000));
    const passwordHash = await hashPassword("first-admin-pass-123");
    const id = await store.createFirstAdmin({ tokenHash: hashToken(raw), email: "Owner@X.local", passwordHash });
    expect(id).toBeTruthy();
    const [row] = await t.super.db
      .execute<{ email: string; role: string; hash: string | null }>(
        sql`SELECT u.email, u.role, c.password_hash AS hash FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.id = ${id}`,
      )
      .then((r) => r.rows);
    expect(row?.email).toBe("owner@x.local"); // normalized
    expect(row?.role).toBe("admin");
    expect(row?.hash).toContain("$scrypt$");
  });

  it("a bare app.is_setup GUC cannot create an admin", async () => {
    // Direct INSERT policies for setup were removed; only the definer function
    // creates the first admin. A GUC alone must not be enough.
    await expect(
      withRlsContext(
        t.app.db,
        { userId: "", role: "user", isAdmin: false, isSupervisorAdmin: false },
        (tx) => tx.execute(sql`INSERT INTO users (email, role) VALUES ('attacker@test.local', 'admin')`),
        { "app.is_setup": "true", "app.bootstrap_token_hash": hashToken("wrong") },
      ),
    ).rejects.toThrow();
    const [row] = await t.super.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM users`).then((r) => r.rows);
    expect(row?.n).toBe(0);
  });

  it("invite accept is atomic, single-use and creates the invited role", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "inv-admin@test.local" });
    const { hash } = issueInviteToken();
    await withRlsContext(
      t.app.db,
      { userId: adminId, role: "admin", isAdmin: true, isSupervisorAdmin: true },
      (tx) =>
        new PostgresInviteStore(tx).create(
          { email: "invited@test.local", role: "supervisor", tokenHash: hash, expiresAt: new Date(Date.now() + 3600_000), invitedBy: adminId },
          { db: tx },
        ),
      { "app.users_admin_write": "true" },
    );
    const store = new PostgresInstanceStore(t.app.db);
    const passwordHash = await hashPassword("invited-pass-12345");
    const id = await store.acceptInvite({ tokenHash: hash, passwordHash });
    expect(id).toBeTruthy();
    // Second accept of the same token -> NULL (single-use).
    expect(await store.acceptInvite({ tokenHash: hash, passwordHash })).toBeNull();
    const [row] = await t.super.db
      .execute<{ email: string; role: string }>(sql`SELECT email, role FROM users WHERE id = ${id}`)
      .then((r) => r.rows);
    expect(row?.email).toBe("invited@test.local");
    expect(row?.role).toBe("supervisor");
  });

  it("an invalid invite token returns NULL", async () => {
    const store = new PostgresInstanceStore(t.app.db);
    expect(await store.acceptInvite({ tokenHash: hashToken("nope"), passwordHash: "x" })).toBeNull();
  });
});
