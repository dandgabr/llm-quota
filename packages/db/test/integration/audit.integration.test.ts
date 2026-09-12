/**
 * Phase B audit integration tests (app-role, adversarial).
 *
 * Proves: events are appended with the actor, the trail is append-only for the
 * app role, supervisor/admin can read and metadata is sanitized.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { resetDatabase, seedUser, setupTestDb, type TestDb } from "../helpers/db.js";
import { PostgresAuditStore, sanitizeMetadata } from "../../src/repositories/audit.js";
import { withRlsContext } from "../../src/repositories/sessions.js";
import { auditEvents } from "../../src/schema/audit.js";

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

describe("Phase B — audit trail", () => {
  it("append-only: the app role cannot UPDATE or DELETE audit events", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "audit-admin@test.local" });
    await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresAuditStore(tx).record({ action: "user.created", actorUserId: adminId, actorRole: "admin" }, { db: tx }),
      { "app.users_admin_write": "true" },
    );
    // UPDATE/DELETE are denied for llmquota_app (REVOKE + no policy).
    await expect(
      t.app.db.execute(sql`UPDATE audit_events SET action = 'user.deleted'`),
    ).rejects.toThrow();
    await expect(t.app.db.execute(sql`DELETE FROM audit_events`)).rejects.toThrow();
    const [row] = await t.super.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_events`).then((r) => r.rows);
    expect(row?.n).toBe(1);
  });

  it("an authenticated actor can append; metadata secrets are stripped", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "meta-admin@test.local" });
    await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) =>
        new PostgresAuditStore(tx).record(
          {
            action: "connection.created",
            actorUserId: adminId,
            actorRole: "admin",
            metadata: { providerKey: "openrouter/api", secret: "sk-should-not-persist" },
          },
          { db: tx },
        ),
      { "app.users_admin_write": "true" },
    );
    const { data } = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresAuditStore(tx).list({}, { db: tx }),
      { "app.is_supervisor_admin": "true" },
    );
    expect(data).toHaveLength(1);
    expect(data[0]?.metadata).toEqual({ providerKey: "openrouter/api" });
  });

  it("a non-supervisor cannot read the audit trail", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "reader-admin@test.local" });
    const userId = await seedUser(t.super, { role: "user", email: "reader-user@test.local" });
    await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresAuditStore(tx).record({ action: "user.created", actorUserId: adminId }, { db: tx }),
      { "app.users_admin_write": "true" },
    );
    const { data } = await withRlsContext(
      t.app.db,
      { userId, role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => new PostgresAuditStore(tx).list({}, { db: tx }),
      {},
    );
    expect(data).toHaveLength(0);
  });

  it("audit metadata sanitizer strips secret-like keys recursively", () => {
    const out = sanitizeMetadata({
      ok: "keep",
      password: "nope",
      nested: { apiKey: "nope", value: 1 },
      list: ["a", "b"],
    });
    expect(out).toEqual({ ok: "keep", nested: { value: 1 }, list: ["a", "b"] });
  });

  it("list supports keyset pagination", async () => {    const adminId = await seedUser(t.super, { role: "admin", email: "page-admin@test.local" });
    for (let i = 0; i < 5; i++) {
      await withRlsContext(
        t.app.db,
        adminPrincipal(adminId),
        (tx) => new PostgresAuditStore(tx).record({ action: "user.created", actorUserId: adminId }, { db: tx }),
        { "app.users_admin_write": "true" },
      );
    }
    const page1 = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresAuditStore(tx).list({ limit: 2 }, { db: tx }),
      { "app.is_supervisor_admin": "true" },
    );
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const [ts, id] = page1.nextCursor!.split("|");
    const page2 = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) =>
        new PostgresAuditStore(tx).list(
          { limit: 2, beforeOccurredAt: new Date(ts!), beforeId: id! },
          { db: tx },
        ),
      { "app.is_supervisor_admin": "true" },
    );
    expect(page2.data).toHaveLength(2);
    // No overlap between pages.
    const ids1 = new Set(page1.data.map((e) => e.id));
    expect(page2.data.every((e) => !ids1.has(e.id))).toBe(true);
    void auditEvents;
    void eq;
  });

  it("F2: the hash chain verifies and detects tampering", async () => {
    const adminId = await seedUser(t.super, { role: "admin", email: "chain@test.local" });
    for (let i = 0; i < 3; i++) {
      await withRlsContext(
        t.app.db,
        adminPrincipal(adminId),
        (tx) => new PostgresAuditStore(tx).record({ action: "user.created", actorUserId: adminId }, { db: tx }),
        { "app.users_admin_write": "true" },
      );
    }
    const ok = await withRlsContext(
      t.app.db,
      adminPrincipal(adminId),
      (tx) => new PostgresAuditStore(tx).verifyChain({ db: tx }),
      { "app.is_admin": "true" },
    );
    expect(ok.ok).toBe(true);
    expect(ok.checked).toBe(3);
    // Tamper via superuser, then verify fails at the altered row.
    await t.super.db.execute(sql`UPDATE audit_events SET action = 'user.deleted' WHERE id = (SELECT id FROM audit_events ORDER BY occurred_at LIMIT 1)`);
    const broken = await t.super.db
      .transaction((tx) => new PostgresAuditStore(tx).verifyChain({ db: tx }))
      .then((r) => r);
    expect(broken.ok).toBe(false);
    expect(broken.brokenAt).toBeTruthy();
  });
});
