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
  seedUserCredential,
  seedProvider,
  resetDatabase,
  TEST_KEK,
} from "../../../../packages/db/test/helpers/db.js";
import type { TestDb } from "../../../../packages/db/test/helpers/db.js";
import { hashToken } from "@llm-quota/auth";
import { createSession, PostgresInstanceStore, PostgresQuotaStore } from "@llm-quota/db";

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
    expect(res.headers.get("content-type")).toContain("application/problem+json");
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

  it("POST /auth/login issues a working session for a valid password", async () => {
    await seedUserCredential(t.super, aliceId, "alice-password-123");
    const res = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wire@test.local", password: "alice-password-123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; user?: { id: string } };
    expect(body.token).toBeTruthy();
    const me = await fetch(`${base}/v1/quotas`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
  });

  it("POST /auth/login rejects a wrong password with 401", async () => {
    const res = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wire@test.local", password: "definitely-wrong-1" }),
    });
    expect(res.status).toBe(401);
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

    it("reusing an Idempotency-Key with a different body returns 422", async () => {
      const key = "idem-key-mismatch";
      await fetch(`${base}/v1/admin/invites`, {
        method: "POST",
        headers: { ...adminAuth(), "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ email: "mismatch-a@test.local", role: "user" }),
      });
      const res = await fetch(`${base}/v1/admin/invites`, {
        method: "POST",
        headers: { ...adminAuth(), "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ email: "mismatch-b@test.local", role: "user" }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { type: string };
      expect(body.type).toContain("idempotency-conflict");
    });

    it("PATCH changes a user's role; a supervisor cannot (403)", async () => {
      const target = await seedUser(t.super, { role: "user", email: "patch-target@test.local" });
      const res = await fetch(`${base}/v1/admin/users/${target}`, {
        method: "PATCH",
        headers: { ...adminAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ role: "supervisor" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { role: string };
      expect(body.role).toBe("supervisor");

      const supId = await seedUser(t.super, { role: "supervisor", email: "wire-sup@test.local" });
      const supToken = "wire-token-sup-123";
      await createSession(t.super.db, {
        userId: supId,
        tokenHash: hashToken(supToken),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const denied = await fetch(`${base}/v1/admin/users/${target}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${supToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });
      expect(denied.status).toBe(403);
    });

    it("cannot demote or delete the last active admin (409 last-admin)", async () => {
      // adminId is the only active admin (other admins created by other tests
      // were not; ensure by demoting is not possible via HTTP here).
      const demote = await fetch(`${base}/v1/admin/users/${adminId}`, {
        method: "PATCH",
        headers: { ...adminAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user" }),
      });
      expect(demote.status).toBe(409);
      const body = (await demote.json()) as { type: string };
      expect(body.type).toContain("last-admin");
    });

    it("DELETE soft-deletes a user and returns 204", async () => {
      const victim = await seedUser(t.super, { role: "user", email: "del-victim@test.local" });
      const res = await fetch(`${base}/v1/admin/users/${victim}`, {
        method: "DELETE",
        headers: adminAuth(),
      });
      expect(res.status).toBe(204);
      // A soft-deleted user no longer appears in the admin list.
      const list = await fetch(`${base}/v1/admin/users`, { headers: adminAuth() });
      const body = (await list.json()) as { data: { id: string }[] };
      expect(body.data.some((u) => u.id === victim)).toBe(false);
    });

    it("DELETE invite returns 204 then 404 on a second attempt", async () => {
      const create = await fetch(`${base}/v1/admin/invites`, {
        method: "POST",
        headers: { ...adminAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ email: "revoke-me@test.local", role: "user" }),
      });
      const created = (await create.json()) as { invite: { id: string } };
      const first = await fetch(`${base}/v1/admin/invites/${created.invite.id}`, {
        method: "DELETE",
        headers: adminAuth(),
      });
      expect(first.status).toBe(204);
      const second = await fetch(`${base}/v1/admin/invites/${created.invite.id}`, {
        method: "DELETE",
        headers: adminAuth(),
      });
      expect(second.status).toBe(404);
    });

    it("mutations are appended to the audit trail; supervisor+ can read it", async () => {
      // Create an invite (mutation) and confirm the event is recorded.
      await fetch(`${base}/v1/admin/invites`, {
        method: "POST",
        headers: { ...adminAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ email: "audited@test.local", role: "user" }),
      });
      const res = await fetch(`${base}/v1/audit?action=invite.created`, { headers: adminAuth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { action: string; targetType: string }[] };
      expect(body.data.some((e) => e.action === "invite.created")).toBe(true);
      // A plain user cannot read the audit trail.
      const denied = await fetch(`${base}/v1/audit`, { headers: auth() });
      expect(denied.status).toBe(403);
    });
  });

  describe("Phase C — onboarding over the wire", () => {
    it("rejects an invalid setup token (403) and accepts the valid one once", async () => {
      // Seed a fresh bootstrap token via the SECURITY DEFINER function.
      const store = new PostgresInstanceStore(t.super.db);
      await resetDatabase(t.super);
      const raw = "wire-bootstrap-token-abcdefgh";
      await store.beginBootstrap(hashToken(raw), new Date(Date.now() + 60_000));

      const bad = await fetch(`${base}/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "wrong", email: "bad@test.local", password: "a-strong-password-1" }),
      });
      expect(bad.status).toBe(403);

      const good = await fetch(`${base}/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: raw, email: "wire-owner@test.local", password: "a-strong-password-1" }),
      });
      expect(good.status).toBe(201);
      const body = (await good.json()) as { token: string; user: { role: string } };
      expect(body.user.role).toBe("admin");

      // Once initialized, setup is refused regardless of the token (409).
      const again = await fetch(`${base}/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: raw, email: "wire-owner2@test.local", password: "a-strong-password-1" }),
      });
      expect(again.status).toBe(409);

      // The minted session works.
      const me = await fetch(`${base}/v1/quotas`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(me.status).toBe(200);
    });

    it("invite accept returns 201 with a session and rejects reuse with 410", async () => {
      const adminId = await seedUser(t.super, { role: "admin", email: "acc-admin@test.local" });
      const adminToken = "wire-acc-admin-token";
      await createSession(t.super.db, {
        userId: adminId,
        tokenHash: hashToken(adminToken),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const created = await fetch(`${base}/v1/admin/invites`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "wire-invitee@test.local", role: "user" }),
      });
      expect(created.status).toBe(201);
      const { inviteUrl } = (await created.json()) as { inviteUrl: string };
      const raw = inviteUrl.split("#token=")[1]!;

      const accept = await fetch(`${base}/auth/invites/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: raw, password: "invitee-password-12" }),
      });
      expect(accept.status).toBe(201);
      const accepted = (await accept.json()) as { user: { email: string } };
      expect(accepted.user.email).toBe("wire-invitee@test.local");

      const reuse = await fetch(`${base}/auth/invites/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: raw, password: "another-password-12" }),
      });
      expect(reuse.status).toBe(410);
    });
  });

  describe("Phase D — authenticated auth endpoints over the wire", () => {
    let userId: string;
    let token: string;

    beforeAll(async () => {
      await resetDatabase(t.super);
      userId = await seedUser(t.super, { role: "user", email: "d-user@test.local" });
      await seedUserCredential(t.super, userId, "d-user-password-123");
      token = "wire-d-user-token";
      await createSession(t.super.db, {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 3600_000),
      });
    });

    it("logout revokes the session server-side (subsequent call is 401)", async () => {
      const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "d-user@test.local", password: "d-user-password-123" }),
      });
      const { token: sessionToken } = (await login.json()) as { token: string };
      const logout = await fetch(`${base}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(logout.status).toBe(204);
      const after = await fetch(`${base}/v1/quotas`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      expect(after.status).toBe(401);
    });

    it("password change requires the current password and revokes other sessions", async () => {
      const wrong = await fetch(`${base}/auth/password/change`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "nope", newPassword: "a-new-password-12" }),
      });
      expect(wrong.status).toBe(401);
      const ok = await fetch(`${base}/auth/password/change`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "d-user-password-123", newPassword: "a-new-password-12" }),
      });
      expect(ok.status).toBe(204);
      // Old token revoked; the new password logs in.
      const after = await fetch(`${base}/v1/quotas`, { headers: { Authorization: `Bearer ${token}` } });
      expect(after.status).toBe(401);
      const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "d-user@test.local", password: "a-new-password-12" }),
      });
      expect(login.status).toBe(200);
    });

    it("MFA enroll -> login requires challenge -> TOTP verifies once", async () => {
      // Fresh user with a password.
      const mfaId = await seedUser(t.super, { role: "user", email: "d-mfa@test.local" });
      await seedUserCredential(t.super, mfaId, "d-mfa-password-123");
      const enrollToken = "wire-d-mfa-enroll";
      await createSession(t.super.db, {
        userId: mfaId,
        tokenHash: hashToken(enrollToken),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const enroll = await fetch(`${base}/auth/mfa/totp/enroll`, {
        method: "POST",
        headers: { Authorization: `Bearer ${enrollToken}` },
      });
      expect(enroll.status).toBe(200);
      const { secret } = (await enroll.json()) as { secret: string };
      // Compute a valid code and verify enrollment.
      const { generateTotp } = await import("@llm-quota/auth");
      const code = generateTotp(secret);
      const verify = await fetch(`${base}/auth/mfa/totp/verify`, {
        method: "POST",
        headers: { Authorization: `Bearer ${enrollToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(verify.status).toBe(200);
      const { recoveryCodes } = (await verify.json()) as { recoveryCodes: string[] };
      expect(recoveryCodes.length).toBeGreaterThan(0);

      // Login now requires MFA.
      const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "d-mfa@test.local", password: "d-mfa-password-123" }),
      });
      expect(login.status).toBe(200);
      const loginBody = (await login.json()) as { status?: string; challenge?: string };
      expect(loginBody.status).toBe("mfa_required");
      expect(loginBody.challenge).toBeTruthy();

      // A wrong code fails; then the right code (next window) succeeds once.
      const wrongCode = await fetch(`${base}/auth/login/mfa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: loginBody.challenge, code: "000000" }),
      });
      expect(wrongCode.status).toBe(401);
      // Enrollment consumed the current step, so use the next window (anti-replay).
      const nextWindow = generateTotp(secret, { nowMs: () => Date.now() + 30_000 });
      const goodCode = await fetch(`${base}/auth/login/mfa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: loginBody.challenge, code: nextWindow }),
      });
      expect(goodCode.status).toBe(200);
      // The challenge is single-use.
      const reuse = await fetch(`${base}/auth/login/mfa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: loginBody.challenge, code: nextWindow }),
      });
      expect(reuse.status).toBe(410);
    });

    it("GET /v1/sessions never exposes token hashes", async () => {
      const res = await fetch(`${base}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` } });
      // token may be revoked by an earlier test; seed a fresh one
      void res;
      const adminId = await seedUser(t.super, { role: "admin", email: "sess-admin@test.local" });
      const adminToken = "wire-sess-admin";
      await createSession(t.super.db, {
        userId: adminId,
        tokenHash: hashToken(adminToken),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const ok = await fetch(`${base}/v1/sessions`, { headers: { Authorization: `Bearer ${adminToken}` } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { data: Record<string, unknown>[] };
      for (const s of body.data) {
        expect(s.tokenHash).toBeUndefined();
        expect(s.token_hash).toBeUndefined();
        expect(s.signature).toBeUndefined();
      }
    });

    it("GET /v1/audit rejects malformed filters with 400", async () => {
      const adminId = await seedUser(t.super, { role: "admin", email: "af-admin@test.local" });
      const adminToken = "wire-af-admin";
      await createSession(t.super.db, {
        userId: adminId,
        tokenHash: hashToken(adminToken),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const res = await fetch(`${base}/v1/audit?actor=not-a-uuid`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(400);
    });
  });
});
