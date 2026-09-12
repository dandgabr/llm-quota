/**
 * llm-quota REST API application (Hono).
 *
 * Phase 5 + final security review (2026-09): safe wire DTOs only (no secret
 * ciphertext crosses the API), real quota reads from persisted snapshots,
 * QUERY (RFC 10008) body parsing, fail-closed dev-only session issuance with
 * HMAC verification, RFC 7807 problem+json on every error path.
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
  PostgresQuotaStore,
  listSessionsByUser,
  resolvePrincipal,
  revokeSession,
  createSession,
  withRlsContext,
  type ResolvedPrincipal,
} from "@llm-quota/db";
import { parseKekFromEnv, windowKey, type Dek, type Granularity } from "@llm-quota/core";
import {
  hasRole,
  generatePkcePair,
  generateOidcState,
  generateWebAuthnChallenge,
  generateTotpSecret,
  issueSessionToken,
  isValidSessionSecret,
} from "@llm-quota/auth";

type Variables = { principal: ResolvedPrincipal };

/** Paths served without a bearer token (health + /auth; auth routes self-gate
 *  behind the ENABLE_DEV_SESSION fail-closed flag). */
const PUBLIC_PREFIXES = ["/health", "/auth"];

const GRANULARITIES: Granularity[] = ["daily", "weekly", "monthly"];

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
  /** Dev-session flag override (tests); defaults to `ENABLE_DEV_SESSION`. */
  enableDevSession?: boolean;
}

function problem(status: number, title: string, detail?: string): Problem {
  return { type: "about:blank", title, status, detail };
}

/**
 * Dev-session gate: fail-closed. The endpoint only exists when the operator
 * EXPLICITLY opts in via `ENABLE_DEV_SESSION=1` AND the process is not in
 * production. There is no default-on path.
 */
function devSessionsEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_SESSION === "1";
}

/**
 * Compose a granularity-prefixed window-key bound from a client instant. The
 * stored keys look like `daily:2026-09-08T00:00:00.000Z` (see core
 * `windowKey`); the prefix must participate in the lexicographic range.
 */
function windowBound(granularity: Granularity, value: string): string | null {
  const prefix = `${granularity}:`;
  const raw = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) return null;
  return `${prefix}${instant.toISOString()}`;
}

/** Create the REST API Hono app. */
export function createApiApp({ db, kek, now, enableDevSession }: ApiAppOptions) {
  const app = new Hono<{ Variables: Variables }>();
  const connStore = new PostgresConnectionStore(db.db, kek ?? parseKekFromEnv());
  const historyStore = new PostgresHistoryStore(db.db);
  const quotaStore = new PostgresQuotaStore(db.db);

  app.use("*", async (c, next) => {
    // Skip auth for public endpoints (health).
    if (PUBLIC_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      return next();
    }
    const auth = c.req.header("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return c.json(problem(401, "Unauthorized", "Missing bearer token"), 401);
    }
    const principal = await resolvePrincipal(
      db.db,
      auth.slice(7),
      now?.(),
      // Defense-in-depth: verify the stored HMAC when the server holds the
      // session-signing secret (guards a leaked hash table).
      process.env.SESSION_SECRET || undefined,
    );
    if (!principal) {
      return c.json(problem(401, "Unauthorized", "Invalid or expired session"), 401);
    }
    c.set("principal", principal);
    await next();
  });

  // RFC 7807 for anything that throws (malformed JSON, repo errors, ...).
  app.onError((err, c) => {
    return c.json(problem(500, "Internal Server Error", err.message), 500);
  });

  // Public: health.
  app.get("/health", (c) => c.json({ ok: true, service: "llm-quota-api" }));

  app.get("/auth/oidc/authorize", (c) => {
    // Gated until server-side state/verifier persistence ships (ADR-009 note):
    // issuing challenge+state without binding them server-side invites CSRF.
    if (!devSessionsEnabled(enableDevSession)) {
      return c.json(problem(403, "Forbidden", "OIDC flow not enabled"), 403);
    }
    // PKCE: return only the challenge + state; NEVER the verifier.
    const { challenge } = generatePkcePair();
    const state = generateOidcState();
    return c.json({ code_challenge: challenge, state });
  });

  app.get("/auth/mfa/totp/challenge", (c) => {
    if (!devSessionsEnabled(enableDevSession)) {
      return c.json(problem(403, "Forbidden", "MFA enrollment not enabled"), 403);
    }
    const secret = generateTotpSecret();
    return c.json({ totp: { secret, verified: false } });
  });

  app.get("/auth/mfa/webauthn/challenge", (c) => {
    if (!devSessionsEnabled(enableDevSession)) {
      return c.json(problem(403, "Forbidden", "MFA enrollment not enabled"), 403);
    }
    return c.json({ challenge: generateWebAuthnChallenge() });
  });

  app.post("/auth/issue-session", async (c) => {
    // Fail-closed dev/test issuance. In production this is disabled; real
    // deployments authenticate via OIDC + MFA (see docs/architecture/security.md).
    if (!devSessionsEnabled(enableDevSession)) {
      return c.json(problem(403, "Forbidden", "Disabled (set ENABLE_DEV_SESSION=1 outside production)"), 403);
    }
    const secret = process.env.SESSION_SECRET ?? "";
    if (!isValidSessionSecret(secret)) {
      return c.json(problem(500, "Server Error", "SESSION_SECRET must be ≥ 32 chars"), 500);
    }
    const body = await c.req
      .json<{ userId: string; role?: "user" | "supervisor" | "admin"; expiresInSec?: number }>()
      .catch(() => null);
    if (!body?.userId) {
      return c.json(problem(400, "Bad Request", "userId required"), 400);
    }
    // Cap the dev-session lifetime (hard upper bound: 24h).
    const expiresInSec = Math.min(Math.max(1, body.expiresInSec ?? 3600), 86_400);
    const { token, hash, signature } = issueSessionToken(secret);
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);
    // INSERT runs under the target owner's RLS context so the
    // user_sessions_own WITH CHECK passes on the non-superuser pool.
    await withRlsContext(
      db.db,
      { userId: body.userId, role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => createSession(tx, { userId: body.userId, tokenHash: hash, signature, expiresAt }),
    );
    return c.json({ token, expiresAt: expiresAt.toISOString() });
  });

  // Connections list: safe DTO projection (never the secret cipher).
  app.get("/v1/connections", async (c) => {
    const p = c.get("principal");
    const rows = await withRlsContext(db.db, p, (tx) =>
      connStore.listByUserView(p.userId, { limit: 50, db: tx }),
    );
    return c.json({ data: rows, has_more: false, next_cursor: null });
  });

  app.post("/v1/connections", async (c) => {
    const body = await c.req
      .json<{
        providerId?: string;
        label?: string;
        connectionType?: "api" | "oauth";
        secret?: string;
      }>()
      .catch(() => null);
    const secret = (body?.secret ?? "").trim();
    if (!body?.providerId || !secret) {
      return c.json(problem(400, "Bad Request", "providerId and secret are required"), 400);
    }
    const p = c.get("principal");
    try {
      const view = await withRlsContext(db.db, p, (tx) =>
        connStore.createAndReturnView({
          userId: p.userId,
          providerId: body.providerId!,
          label: body.label ?? "unnamed",
          connectionType: body.connectionType ?? "api",
          secret,
          db: tx,
        }),
      );
      return c.json(view, 201);
    } catch (err) {
      // Unknown providerId trips the FK constraint -> client error, not 500.
      return c.json(problem(400, "Bad Request", `Connection rejected: ${String(err)}`), 400);
    }
  });

  // Quotas list: latest persisted snapshot per connection (real quota read).
  app.get("/v1/quotas", async (c) => {
    const p = c.get("principal");
    const rows = await withRlsContext(db.db, p, (tx) =>
      quotaStore.latestPerConnection(p.userId, { limit: 100, db: tx }),
    );
    return c.json({ data: rows, has_more: false, next_cursor: null });
  });

  app.get("/v1/quotas/summary", async (c) => {
    const p = c.get("principal");
    if (!hasRole(p.role, "supervisor")) {
      return c.json(problem(403, "Forbidden", "Supervisor role required"), 403);
    }
    // Supervisor read: month-to-date spend totals by currency (the RLS
    // supervisor-read policy scopes the rows inside the transaction).
    const monthStart = new Date();
    monthStart.setUTCMonth(monthStart.getUTCMonth(), 1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const totals = await withRlsContext(db.db, p, (tx) =>
      historyStore.sumByCurrencySince("monthly", windowKey("monthly", monthStart), { db: tx }),
    );
    return c.json({
      summary: {
        month: monthStart.toISOString().slice(0, 7),
        totals,
      },
    });
  });

  // QUERY (RFC 10008) + GET alias share one handler (ADR-008). Params come
  // from the JSON body (QUERY) merged over the query string (GET alias).
  const readHistory = async (c: {
    req: {
      method: string;
      query(name: string): string | undefined;
      raw: { json(): Promise<unknown> };
    };
    get(name: "principal"): ResolvedPrincipal;
    json(body: unknown, status?: number): Response;
  }) => {
    const p = c.get("principal");
    let body: Record<string, unknown> = {};
    if (c.req.method === "QUERY") {
      body = ((await c.req.raw.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    }
    const pick = (key: string): string | undefined => {
      const v = body[key];
      if (typeof v === "string" && v.length > 0) return v;
      return c.req.query(key);
    };
    const granularity = (pick("granularity") ?? "weekly") as Granularity;
    if (!GRANULARITIES.includes(granularity)) {
      return c.json(problem(400, "Bad Request", "granularity must be daily|weekly|monthly"), 400);
    }
    // Defaults: no bounds => the full retained window (12 months) is returned.
    // Bounds are granularity-prefixed so the lexicographic range matches the
    // stored window keys.
    const fromRaw = pick("from");
    const toRaw = pick("to");
    const from = fromRaw ? windowBound(granularity, fromRaw) : null;
    const to = toRaw ? windowBound(granularity, toRaw) : null;
    if ((fromRaw && !from) || (toRaw && !to)) {
      return c.json(problem(400, "Bad Request", "from/to must be an ISO instant"), 400);
    }
    const rows = await withRlsContext(db.db, p, (tx) =>
      new PostgresHistoryStore(tx).listByUser(
        p.userId,
        granularity,
        from ?? "",
        to ?? "",
      ),
    );
    return c.json({ data: rows, has_more: false, next_cursor: null });
  };
  app.get("/v1/history", readHistory);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).on("QUERY", "/v1/history", readHistory);

  app.get("/v1/sessions", (c) => {
    const p = c.get("principal");
    return withRlsContext(db.db, p, (tx) => listSessionsByUser(tx, p.userId)).then((rows) =>
      c.json({ data: rows }),
    );
  });

  app.delete("/v1/sessions/:id", async (c) => {
    const p = c.get("principal");
    const n = await withRlsContext(db.db, p, (tx) => revokeSession(tx, c.req.param("id"), p.userId));
    if (n === 0) return c.json(problem(404, "Not Found", "Session not found"), 404);
    return c.json({ ok: true });
  });

  return app;
}
