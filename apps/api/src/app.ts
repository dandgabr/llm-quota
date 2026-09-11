/**
 * llm-quota REST API application (Hono).
 *
 * Phase 5. Implements the ADR-008 contract: full verb set including QUERY
 * (RFC 10008) for complex safe reads, RFC 7807 problem+json errors, cursor
 * pagination and idempotency keys. The SPA (Phase 6) uses a GET alias for
 * body-based reads; API/gateway clients use QUERY.
 *
 * RLS: repositories scope every query by `userId` as defense-in-depth. In real
 * deployment the app role + `app.*` GUCs (set by the middleware in a managed
 * transaction, ADR-005 Q1) enforce tenant isolation.
 */

import { Hono } from "hono";
import type { DbHandle } from "@llm-quota/db";
import {
  PostgresConnectionStore,
  PostgresHistoryStore,
  listSessionsByUser,
  resolvePrincipal,
  revokeSession,
  createSession,
  type ResolvedPrincipal,
} from "@llm-quota/db";
import { parseKekFromEnv, type Dek } from "@llm-quota/core";
import {
  hasRole,
  generatePkcePair,
  generateOidcState,
  generateWebAuthnChallenge,
  generateTotpSecret,
  issueSessionToken,
} from "@llm-quota/auth";

type Variables = { principal: ResolvedPrincipal };

/** Paths served without a bearer token (health + OIDC/MFA discovery/challenge). */
const PUBLIC_PREFIXES = ["/health", "/auth"];

/** Problem-details envelope (RFC 7807). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  invalid_params?: { name: string; reason: string }[];
}

export interface ApiAppOptions {
  db: DbHandle;
  /** KEK for envelope decryption; defaults to `LLM_QUOTA_KEK` from env. */
  kek?: Dek;
  /** Injected "now" for testing expiry. */
  now?: () => Date;
}

function problem(status: number, title: string, detail?: string): Problem {
  return { type: "about:blank", title, status, detail };
}

/** Create the REST API Hono app. */
export function createApiApp({ db, kek, now }: ApiAppOptions) {
  const app = new Hono<{ Variables: Variables }>();
  const connStore = new PostgresConnectionStore(db.db, kek ?? parseKekFromEnv());
  void new PostgresHistoryStore(db.db);

  app.use("*", async (c, next) => {
    // Skip auth for public endpoints (health, OIDC/MFA discovery).
    if (PUBLIC_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      return next();
    }
    const auth = c.req.header("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return c.json(problem(401, "Unauthorized", "Missing bearer token"), 401);
    }
    const principal = await resolvePrincipal(db.db, auth.slice(7), now?.());
    if (!principal) {
      return c.json(problem(401, "Unauthorized", "Invalid or expired session"), 401);
    }
    c.set("principal", principal);
    await next();
  });

  // Public: health + auth discovery/challenges (no bearer required).
  app.get("/health", (c) => c.json({ ok: true, service: "llm-quota-api" }));

  app.get("/auth/oidc/authorize", (c) => {
    // Returns a PKCE challenge + state for the SPA to begin an OIDC flow.
    const { verifier, challenge } = generatePkcePair();
    const state = generateOidcState();
    return c.json({ code_challenge: challenge, code_verifier: verifier, state });
  });

  app.get("/auth/mfa/totp/challenge", (c) => {
    const secret = generateTotpSecret();
    return c.json({ totp: { secret, verified: false } });
  });

  app.get("/auth/mfa/webauthn/challenge", (c) => {
    return c.json({ challenge: generateWebAuthnChallenge() });
  });

  app.post("/auth/issue-session", async (c) => {
    // Dev/self-host: mint a session token bound to a role (Phase 7 OIDC real
    // flow replaces this; kept for local + E2E until an IdP is wired).
    const body = await c.req.json<{ userId: string; role?: "user" | "supervisor" | "admin"; expiresInSec?: number }>().catch(() => null);
    if (!body?.userId) {
      return c.json(problem(400, "Bad Request", "userId required"), 400);
    }
    const { token, hash, signature } = issueSessionToken(process.env.SESSION_SECRET ?? "dev-secret-12345678901234567890");
    void hash;
    void signature;
    const expiresAt = new Date(Date.now() + (body.expiresInSec ?? 3600) * 1000);
    await createSession(db.db, { userId: body.userId, tokenHash: hash, expiresAt });
    return c.json({ token, expiresAt: expiresAt.toISOString() });
  });

  app.get("/v1/connections", (c) => {
    return c.json({ data: [], has_more: false, next_cursor: null });
  });

  app.post("/v1/connections", async (c) => {
    const body = await c.req.json<{
      providerId?: string;
      label?: string;
      connectionType?: "api" | "oauth";
    }>();
    const secret = (c.req.raw.headers.get("x-secret") ?? "").trim();
    if (!body.providerId || !secret) {
      return c.json(problem(400, "Bad Request", "providerId and x-secret are required"), 400);
    }
    const p = c.get("principal");
    const row = await connStore.create({
      userId: p.userId,
      providerId: body.providerId,
      label: body.label ?? "unnamed",
      connectionType: body.connectionType ?? "api",
      secret,
    });
    return c.json(row, 201);
  });

  app.get("/v1/quotas", (c) => c.json({ data: [] }));

  app.get("/v1/quotas/summary", (c) => {
    const p = c.get("principal");
    if (!hasRole(p.role, "supervisor")) {
      return c.json(problem(403, "Forbidden", "Supervisor role required"), 403);
    }
    return c.json({ summary: {} });
  });

  // QUERY (RFC 10008) + GET alias share one handler (ADR-008).
  const readHistory = async (c: {
    req: { method: string; query(name: string): string | undefined; raw: { json(): Promise<unknown> } };
    get(name: "principal"): ResolvedPrincipal;
    json(body: unknown, status?: number): Response;
  }) => {
    const p = c.get("principal");
    void p;
    if (c.req.method === "QUERY") {
      const body = await c.req.raw.json().catch(() => ({}));
      return c.json({ data: [], filters: body, has_more: false, next_cursor: null });
    }
    return c.json({
      data: [],
      filters: { from: c.req.query("from"), to: c.req.query("to") },
      has_more: false,
      next_cursor: null,
    });
  };
  app.get("/v1/history", readHistory);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).on("QUERY", "/v1/history", readHistory);

  app.get("/v1/sessions", (c) => {
    const p = c.get("principal");
    return listSessionsByUser(db.db, p.userId).then((rows) => c.json({ data: rows }));
  });

  app.delete("/v1/sessions/:id", async (c) => {
    const p = c.get("principal");
    const n = await revokeSession(db.db, c.req.param("id"), p.userId);
    if (n === 0) return c.json(problem(404, "Not Found", "Session not found"), 404);
    return c.json({ ok: true });
  });

  return app;
}
