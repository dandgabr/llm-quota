import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, seedUser, seedConnection, seedProvider, resetDatabase, TEST_KEK } from "../helpers/db.js";
import type { TestDb } from "../helpers/db.js";
import { PostgresConnectionStore } from "../../src/repositories/connections.js";
import { createSession, resolvePrincipal } from "../../src/repositories/sessions.js";
import { encryptSecret, decryptSecret } from "@llm-quota/core";
import { hashToken } from "@llm-quota/auth";

let t: TestDb;
let aliceId: string;
let providerId: string;

beforeAll(async () => {
  t = await setupTestDb({ migrate: true });
  await resetDatabase(t.super);
  aliceId = await seedUser(t.super, { role: "user", email: "alice@test.local" });
  providerId = await seedProvider(t.super, "ollama-claude/api");
  await seedConnection(t.super, { userId: aliceId, providerId, label: "alice", secret: "sk-alice" });
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("connections repo — real Postgres", () => {
  it("persists a sealed secret that never appears as plaintext", async () => {
    const store = new PostgresConnectionStore(t.super.db, TEST_KEK);
    const secret = "sk-confidential-xyz";
    const row = await store.create({ userId: aliceId, providerId, label: "leak", connectionType: "api", secret });
    expect(row.secretCipher).toMatch(/^v1\./);
    expect(row.secretCipher).not.toContain(secret);
    // Raw DB row (superuser peek) must not hold plaintext.
    const raw = await t.super.db.execute(`select secret_cipher from connections where id = '${row.id}'`);
    expect(JSON.stringify(raw.rows)).not.toContain(secret);
  });

  it("round-trips the secret through decrypt", async () => {
    const store = new PostgresConnectionStore(t.super.db, TEST_KEK);
    const secret = "sk-roundtrip";
    const row = await store.create({ userId: aliceId, providerId, label: "rt", connectionType: "api", secret });
    const found = await store.findById(row.id, aliceId);
    expect(found?.secret).toBe(secret);
  });

  it("throws on decrypt with the wrong KEK", async () => {
    const wrong = Buffer.alloc(32, 9);
    const cipher = encryptSecret("sk-wrong", TEST_KEK);
    expect(() => decryptSecret(cipher, wrong)).toThrow();
  });

  it("scopes reads/writes by owner (BOLA defense)", async () => {
    const storeA = new PostgresConnectionStore(t.super.db, TEST_KEK);
    const bob = await seedUser(t.super, { role: "user", email: "bob@test.local" });
    const rowB = await storeA.create({ userId: bob, providerId, label: "bob", connectionType: "api", secret: "sk-bob" });
    // alice cannot read bob's, bob cannot read alice's via findById with wrong owner
    expect(await storeA.findById(rowB.id, aliceId)).toBeNull();
    // listByUser(alice) only returns alice's
    const aliceRows = await storeA.listByUser(aliceId, { limit: 100 });
    expect(aliceRows.every((r) => r.userId === aliceId)).toBe(true);
  });
});

describe("sessions + resolvePrincipal — real Postgres", () => {
  it("resolvePrincipal returns the seeded user's principal", async () => {
    const token = "real-token-abc123";
    await createSession(t.super.db, {
      userId: aliceId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const p = await resolvePrincipal(t.super.db, token, new Date());
    expect(p?.userId).toBe(aliceId);
    expect(p?.isAdmin).toBe(false);
  });

  it("returns null for an unknown token", async () => {
    expect(await resolvePrincipal(t.super.db, "no-such-token", new Date())).toBeNull();
  });
});
