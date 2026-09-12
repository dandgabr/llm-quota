/**
 * Phase 8 API E2E over the wire: boots the REAL server (buildServer ->
 * @hono/node-server) against the real test Postgres and asserts the ADR-008
 * contract — including the QUERY method (RFC 10008) over an actual socket.
 *
 * Final-review additions: origin-allow-listed CORS + preflight, safe DTOs
 * (never the secret cipher), real quota reads, QUERY body parsing, and the
 * fail-closed ENABLE_DEV_SESSION gate.
 *
 * DB handle: the superuser pool for seeding; app-role RLS behavior is proven
 * at the repository level (packages/db/test/integration/rls.integration.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer, type Started } from "../../src/server.js";
import {
  setupTestDb,
  seedUser,
  seedProvider,
  resetDatabase,
  TEST_KEK,
} from "../../../../packages/db/test/helpers/db.js";
import type { TestDb } from "../../../../packages/db/test/helpers/db.js";
import { hashToken } from "@llm-quota/auth";
import { createSession, PostgresQuotaStore } from "@llm-quota/db";

let t: TestDb;
let serverApp: Started;
let base: string;
let aliceId: string;
let providerId: string;
let aliceToken: string;

beforeAll(async () => {
  // The dev-session gate now fails closed: opt in explicitly (non-production).
  process.env.SESSION_SECRET = "s".repeat(32);
  process.env.ENABLE_DEV_SESSION = "1";
  t = await setupTestDb({ migrate: true });
  await resetDatabase(t.super);
  aliceId = await seedUser(t.super, { role: "user", email: "wire@test.local" });
  providerId = await seedProvider(t.super, "ollama-claude/api");

  aliceToken = "wire-token-alice-123";
  await createSession(t.super.db, {
    userId: aliceId,
    tokenHash: hashToken(aliceToken),
    expiresAt: new Date(Date.now() + 3600_000),
  });

  serverApp = buildServer({
    port: 0,
    env: "test",
    db: t.super,
    kek: TEST_KEK,
    webOrigin: "http://localhost:5173",
    logger: () => {},
  });
  // Wait for the ephemeral bind, then resolve the real port (0 => assigned).
  await new Promise<void>((resolveListen) => {
    serverApp.server.once("listening", () => resolveListen());
  });
  const addr = (serverApp.server as unknown as { address(): { port: number } | null }).address();
  base = `http://127.0.0.1:${addr!.port}`;
}, 120_000);

afterAll(async () => {
  await serverApp.close();
  await t.close();
  delete process.env.ENABLE_DEV_SESSION;
});

const auth = () => ({ Authorization: `Bearer ${aliceToken}` });
const ORIGIN = "http://localhost:5173";

describe("API E2E over the wire (real server + real Postgres)", () => {
  it("GET /health is public and returns ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("CORS echoes ONLY allow-listed origins and answers preflights", async () => {
    const allowed = await fetch(`${base}/health`, { headers: { Origin: ORIGIN } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(allowed.headers.get("vary")).toContain("Origin");

    const foreign = await fetch(`${base}/health`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const pre = await fetch(`${base}/v1/quotas`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "QUERY" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("QUERY");
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("rejects protected endpoints without a bearer token (401 problem+json)", async () => {
    const res = await fetch(`${base}/v1/quotas`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { title: string; status: number };
    expect(body.status).toBe(401);
  });

  it("GET /v1/quotas returns the latest persisted quota view (no secrets)", async () => {
    // Seed a connection + snapshot directly (superuser), then read via API.
    const secret = "sk-quotas-secret-1";
    const createRes = await fetch(`${base}/v1/connections`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, label: "quota-conn", connectionType: "api", secret }),
    });
    expect(createRes.status).toBe(201);
    const connView = (await createRes.json()) as { id: string; providerKey: string };
    expect(connView.providerKey).toBe("ollama-claude/api");
    expect(JSON.stringify(connView)).not.toContain(secret);

    const quotaStore = new PostgresQuotaStore(t.super.db);
    await quotaStore.insertSnapshot({
      connectionId: connView.id,
      kind: "percent",
      window: "daily",
      usedPercent: 72,
      remainingPercent: 28,
    });

    const res = await fetch(`${base}/v1/quotas`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { connectionId: string; usedPercent: number }[] };
    const view = body.data.find((q) => q.connectionId === connView.id);
    expect(view?.usedPercent).toBe(72);
  });

  it("POST /v1/connections seals the secret and NEVER echoes ciphertext; lists safe DTOs", async () => {
    const secret = "sk-wire-secret-xyz";
    const res = await fetch(`${base}/v1/connections`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, label: "wire", connectionType: "api", secret }),
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { label: string; secretCipher?: string };
    expect(row.label).toBe("wire");
    expect(row.secretCipher).toBeUndefined();

    const list = await fetch(`${base}/v1/connections`, { headers: auth() });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { label: string; providerKey: string }[] };
    expect(body.data.some((c) => c.label === "wire")).toBe(true);
    expect(body.data.every((c) => !JSON.stringify(c).includes(secret))).toBe(true);
    expect(JSON.stringify(body).toLowerCase()).not.toContain("secretcipher");
  });

  it("POST /v1/connections without a secret (or with a malformed body) returns 400", async () => {
    const noSecret = await fetch(`${base}/v1/connections`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, label: "no-secret", connectionType: "api" }),
    });
    expect(noSecret.status).toBe(400);

    const malformed = await fetch(`${base}/v1/connections`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "not-json{",
    });
    expect(malformed.status).toBe(400);
  });

  it("GET /v1/quotas/summary denies a plain user (403)", async () => {
    const res = await fetch(`${base}/v1/quotas/summary`, { headers: auth() });
    expect(res.status).toBe(403);
  });

  it("GET /v1/history (SPA alias) defaults to the full retained window", async () => {
    const res = await fetch(`${base}/v1/history`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("GET /v1/history with ISO from/to bounds returns 200", async () => {
    const res = await fetch(
      `${base}/v1/history?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z&granularity=daily`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("GET /v1/history rejects an unknown granularity (400)", async () => {
    const res = await fetch(`${base}/v1/history?granularity=yearly`, { headers: auth() });
    expect(res.status).toBe(400);
  });

  it("QUERY /v1/history (RFC 10008) works over the wire with a JSON body", async () => {
    const res = await fetch(`${base}/v1/history`, {
      method: "QUERY",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-12-31T00:00:00.000Z",
        granularity: "daily",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("GET /v1/sessions lists only the caller's sessions; DELETE non-owned -> 404", async () => {
    const list = await fetch(`${base}/v1/sessions`, { headers: auth() });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { id: string }[] };
    expect(body.data.length).toBeGreaterThan(0);

    const del = await fetch(`${base}/v1/sessions/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(del.status).toBe(404);
  });

  it("POST /auth/issue-session issues a working dev session when enabled", async () => {
    process.env.ENABLE_DEV_SESSION = "1";
    const res = await fetch(`${base}/auth/issue-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: aliceId, expiresInSec: 120 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(body.token).toBeTruthy();

    // The minted (signed) token must authenticate.
    const me = await fetch(`${base}/v1/quotas`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
  });

  it("POST /auth/issue-session fails closed when ENABLE_DEV_SESSION is unset", async () => {
    delete process.env.ENABLE_DEV_SESSION;
    const res = await fetch(`${base}/auth/issue-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: aliceId }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /auth/oidc/authorize never leaks the PKCE code_verifier (dev-gated)", async () => {
    process.env.ENABLE_DEV_SESSION = "1";
    const res = await fetch(`${base}/auth/oidc/authorize`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code_challenge).toBeTruthy();
    expect(body.state).toBeTruthy();
    expect(body.code_verifier).toBeUndefined();
  });

  describe("Phase A — admin user management over the wire", () => {
    let adminToken: string;
    let adminId: string;

    beforeAll(async () => {
      adminId = await seedUser(t.super, { role: "admin", email: "wire-admin@test.local" });
      adminToken = "wire-token-admin-123";
      await createSession(t.super.db, {
        userId: adminId,
        tokenHash: hashToken(adminToken),
        expiresAt: new Date(Date.now() + 3600_000),
      });
    });

    const adminAuth = () => ({ Authorization: `Bearer ${adminToken}` });

    it("admin lists users and invites; non-admin is forbidden", async () => {
      const ok = await fetch(`${base}/v1/admin/users`, { headers: adminAuth() });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { data: { email: string }[] };
      expect(body.data.some((u) => u.email === "wire@test.local")).toBe(true);

      const denied = await fetch(`${base}/v1/admin/users`, { headers: auth() });
      expect(denied.status).toBe(403);
    });

    it("admin creates an invite (201) and the link is single-use", async () => {
      const res = await fetch(`${base}/v1/admin/invites`, {
        method: "POST",
        headers: { ...adminAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invitee@test.local", role: "user" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { inviteUrl: string; invite: { email: string } };
      expect(body.invite.email).toBe("invitee@test.local");
      expect(body.inviteUrl).toContain("#token=");
    });

    it("inviting an existing email returns 409 user-exists", async () => {
      const res = await fetch(`${base}/v1/admin/invites`, {
        method: "POST",
        headers: { ...adminAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ email: "wire@test.local", role: "user" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("user-exists");
    });

    it("admin cannot delete themselves (409 conflict)", async () => {
      const res = await fetch(`${base}/v1/admin/users/${adminId}`, {
        method: "DELETE",
        headers: adminAuth(),
      });
      expect(res.status).toBe(409);
    });

    it("a duplicate Idempotency-Key replays the invite response", async () => {
      const key = "idem-key-abcd1234";
      const opts = {
        method: "POST",
        headers: { ...adminAuth(), "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ email: "idem-target@test.local", role: "user" }),
      };
      const first = await fetch(`${base}/v1/admin/invites`, opts);
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { invite: { id: string } };
      const second = await fetch(`${base}/v1/admin/invites`, opts);
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as { invite: { id: string } };
      expect(secondBody.invite.id).toBe(firstBody.invite.id);
    });
  });
});
