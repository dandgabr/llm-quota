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
import { createHash } from "node:crypto";
import type { DbHandle } from "@llm-quota/db";
import {
  PostgresConnectionStore,
  PostgresHistoryStore,
  PostgresQuotaStore,
  PostgresUserStore,
  PostgresInviteStore,
  PostgresIdempotencyStore,
  listSessionsByUser,
  resolvePrincipal,
  revokeSession,
  createSession,
  withRlsContext,
  type ResolvedPrincipal,
  type Role,
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
  issueInviteToken,
} from "@llm-quota/auth";

type Variables = { principal: ResolvedPrincipal };

/**
 * Paths served without a bearer token. Matched by SEGMENT (not bare
 * startsWith) so `/authentication-x` is never treated as public.
 */
const PUBLIC_PATHS = ["/health", "/auth"];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

const GRANULARITIES: Granularity[] = ["daily", "weekly", "monthly"];

/** Stable RFC 7807 `type` URIs so clients can branch on the error class. */
const PROBLEM_TYPES: Record<string, string> = {
  unauthorized: "https://api.llm-quota.dev/errors/unauthorized",
  forbidden: "https://api.llm-quota.dev/errors/forbidden",
  not_found: "https://api.llm-quota.dev/errors/not-found",
  invalid_params: "https://api.llm-quota.dev/errors/invalid-params",
  conflict: "https://api.llm-quota.dev/errors/conflict",
  last_admin: "https://api.llm-quota.dev/errors/last-admin",
  user_exists: "https://api.llm-quota.dev/errors/user-exists",
  invite_expired: "https://api.llm-quota.dev/errors/invite-expired",
  account_locked: "https://api.llm-quota.dev/errors/account-locked",
  mfa_required: "https://api.llm-quota.dev/errors/mfa-required",
  rate_limited: "https://api.llm-quota.dev/errors/rate-limited",
  payload_too_large: "https://api.llm-quota.dev/errors/payload-too-large",
  idempotency_conflict: "https://api.llm-quota.dev/errors/idempotency-conflict",
  internal: "https://api.llm-quota.dev/errors/internal",
};

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
  /** Public base URL used to build invite links. */
  publicWebUrl?: string;
}

function problem(
  status: number,
  title: string,
  detail?: string,
  typeKey: keyof typeof PROBLEM_TYPES | string = "internal",
  invalidParams?: { name: string; reason: string }[],
): Problem {
  return {
    type: PROBLEM_TYPES[typeKey] ?? typeKey,
    title,
    status,
    detail,
    invalid_params: invalidParams,
  };
}

/**
 * Dev-session gate: fail-closed. Requires a non-production env AND the
 * explicit `ENABLE_DEV_SESSION=1` opt-in. Production/staging stay blocked even
 * if the flag is set. Slated for removal in Phase D (real login replaces it).
 */
function devSessionsEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const env = process.env.NODE_ENV;
  return (env === "development" || env === "test") && process.env.ENABLE_DEV_SESSION === "1";
}

/** Validate the `Idempotency-Key` header shape. */
function validIdempotencyKey(key: string | undefined): key is string {
  return typeof key === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(key);
}

/** Stable hash of a request's method + path template + body (idempotency). */
function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method}\n${path}\n${JSON.stringify(body ?? null)}`)
    .digest("hex");
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
export function createApiApp({ db, kek, now, enableDevSession, publicWebUrl }: ApiAppOptions) {
  const app = new Hono<{ Variables: Variables }>();
  const connStore = new PostgresConnectionStore(db.db, kek ?? parseKekFromEnv());
  const historyStore = new PostgresHistoryStore(db.db);
  const quotaStore = new PostgresQuotaStore(db.db);
  const userStore = new PostgresUserStore(db.db);
  const inviteStore = new PostgresInviteStore(db.db);
  const idempotencyStore = new PostgresIdempotencyStore(db.db);
  const webBase = publicWebUrl ?? process.env.PUBLIC_WEB_URL ?? "";

  app.use("*", async (c, next) => {
    // Skip auth for public endpoints (health + auth, matched by segment).
    if (isPublicPath(c.req.path)) {
      return next();
    }
    const auth = c.req.header("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return c.json(problem(401, "Unauthorized", "Missing bearer token", "unauthorized"), 401);
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
      return c.json(problem(401, "Unauthorized", "Invalid or expired session", "unauthorized"), 401);
    }
    c.set("principal", principal);
    await next();
  });

  // RFC 7807 for anything that throws (malformed JSON, repo errors, ...).
  app.onError((err, c) => {
    return c.json(problem(500, "Internal Server Error", err.message, "internal"), 500);
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
      return c.json(problem(403, "Forbidden", "Disabled (set ENABLE_DEV_SESSION=1 outside production)", "forbidden"), 403);
    }
    const secret = process.env.SESSION_SECRET ?? "";
    if (!isValidSessionSecret(secret)) {
      return c.json(problem(500, "Server Error", "SESSION_SECRET must be ≥ 32 chars", "internal"), 500);
    }
    const body = await c.req
      .json<{ userId: string; role?: "user" | "supervisor" | "admin"; expiresInSec?: number }>()
      .catch(() => null);
    if (!body?.userId) {
      return c.json(problem(400, "Bad Request", "userId required", "invalid_params"), 400);
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

  // ---- User management (Phase A / ADR-013) --------------------------------
  // All routes are admin-gated at the handler AND by the RLS write policies
  // (defense in depth). The `users_admin_write` GUC is set via withRlsContext
  // `extra` so the anti-escalation trigger and admin policies apply.
  const requireAdmin = (c: { get(name: "principal"): ResolvedPrincipal }): ResolvedPrincipal | null => {
    const p = c.get("principal");
    return p.isAdmin ? p : null;
  };

  app.get("/v1/admin/users", async (c) => {
    const p = c.get("principal");
    if (!hasRole(p.role, "supervisor")) {
      return c.json(problem(403, "Forbidden", "Supervisor role required", "forbidden"), 403);
    }
    const rows = await withRlsContext(
      db.db,
      p,
      (tx) => userStore.list({ db: tx }),
      { "app.is_supervisor_admin": "true" },
    );
    return c.json({ data: rows, has_more: false, next_cursor: null });
  });

  app.patch("/v1/admin/users/:id", async (c) => {
    const p = requireAdmin(c);
    if (!p) return c.json(problem(403, "Forbidden", "Admin role required", "forbidden"), 403);
    const body = await c.req.json<{ role?: Role; isActive?: boolean }>().catch(() => null);
    if (!body || (body.role === undefined && body.isActive === undefined)) {
      return c.json(problem(400, "Bad Request", "role or isActive required", "invalid_params"), 400);
    }
    const target = c.req.param("id");
    const result = await withRlsContext(
      db.db,
      p,
      async (tx) => {
        await userStore.lockLastAdminGuard(tx);
        // Last-admin guard: never remove the final active admin.
        if (body.role !== undefined || body.isActive === false) {
          const remaining = await userStore.countActiveAdmins({ db: tx, excludeUserId: target });
          const current = await userStore.findById(target, { db: tx });
          if (current?.role === "admin" && remaining < 1) return { kind: "last_admin" as const };
        }
        if (target === p.userId && body.isActive === false) return { kind: "self" as const };
        if (body.role !== undefined) {
          if (target === p.userId) return { kind: "self" as const };
          const view = await userStore.updateRole(target, body.role, { db: tx });
          if (!view) return { kind: "not_found" as const };
        }
        if (body.isActive !== undefined) {
          const view = await userStore.setActive(target, body.isActive, { db: tx });
          if (!view) return { kind: "not_found" as const };
        }
        const view = await userStore.findById(target, { db: tx });
        return { kind: "ok" as const, view };
      },
      { "app.users_admin_write": "true" },
    );
    if (result.kind === "last_admin") {
      return c.json(problem(409, "Conflict", "cannot remove the last active admin", "last_admin"), 409);
    }
    if (result.kind === "self") {
      return c.json(problem(409, "Conflict", "cannot change your own role or block yourself", "conflict"), 409);
    }
    if (result.kind === "not_found") {
      return c.json(problem(404, "Not Found", "User not found", "not_found"), 404);
    }
    return c.json(result.view);
  });

  app.delete("/v1/admin/users/:id", async (c) => {
    const p = requireAdmin(c);
    if (!p) return c.json(problem(403, "Forbidden", "Admin role required", "forbidden"), 403);
    const target = c.req.param("id");
    if (target === p.userId) {
      return c.json(problem(409, "Conflict", "cannot delete yourself", "conflict"), 409);
    }
    const result = await withRlsContext(
      db.db,
      p,
      async (tx) => {
        await userStore.lockLastAdminGuard(tx);
        const current = await userStore.findById(target, { db: tx });
        if (!current) return "not_found" as const;
        if (current.role === "admin") {
          const remaining = await userStore.countActiveAdmins({ db: tx, excludeUserId: target });
          if (remaining < 1) return "last_admin" as const;
        }
        const ok = await userStore.softDelete(target, { db: tx });
        return ok ? ("ok" as const) : ("not_found" as const);
      },
      { "app.users_admin_write": "true" },
    );
    if (result === "last_admin") {
      return c.json(problem(409, "Conflict", "cannot delete the last active admin", "last_admin"), 409);
    }
    if (result === "not_found") {
      return c.json(problem(404, "Not Found", "User not found", "not_found"), 404);
    }
    return c.body(null, 204);
  });

  // ---- Invites ------------------------------------------------------------
  app.get("/v1/admin/invites", async (c) => {
    const p = requireAdmin(c);
    if (!p) return c.json(problem(403, "Forbidden", "Admin role required", "forbidden"), 403);
    const rows = await withRlsContext(db.db, p, (tx) => inviteStore.list({ db: tx }), {
      "app.users_admin_write": "true",
    });
    return c.json({ data: rows, has_more: false, next_cursor: null });
  });

  app.post("/v1/admin/invites", async (c) => {
    const p = requireAdmin(c);
    if (!p) return c.json(problem(403, "Forbidden", "Admin role required", "forbidden"), 403);
    const body = await c.req
      .json<{ email?: string; role?: Role; expiresInHours?: number }>()
      .catch(() => null);
    const email = (body?.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return c.json(problem(400, "Bad Request", "valid email required", "invalid_params"), 400);
    }
    const role: Role = body?.role && ["user", "supervisor", "admin"].includes(body.role) ? body.role : "user";
    const expiresInHours = Math.min(Math.max(1, body?.expiresInHours ?? 72), 168);
    // Idempotency: a retry with the same key replays the original response
    // instead of minting a second invite. Run under the admin RLS context.
    const idemKey = c.req.header("idempotency-key");
    const useIdem = validIdempotencyKey(idemKey);
    const rHash = requestHash("POST", "/v1/admin/invites", { email, role, expiresInHours });
    const result = await withRlsContext(
      db.db,
      p,
      async (tx) => {
        if (useIdem) {
          const claim = await idempotencyStore.claim(p.userId, idemKey, rHash, 86_400, { db: tx });
          if (claim.kind === "replay") {
            return { kind: "replay" as const, status: claim.status ?? 201, body: claim.body ?? "{}" };
          }
          if (claim.kind === "hash_mismatch") return { kind: "hash_mismatch" as const };
          if (claim.kind === "conflict") return { kind: "idem_conflict" as const };
        }
        if (await inviteStore.emailInUse(email, { db: tx })) {
          return { kind: "user_exists" as const };
        }
        const { token, hash } = issueInviteToken();
        const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000);
        const invite = await inviteStore.create(
          { email, role, tokenHash: hash, expiresAt, invitedBy: p.userId },
          { db: tx },
        );
        const inviteUrl = webBase
          ? `${webBase}/invite#token=${token}`
          : `/invite#token=${token}`;
        const payload = { invite, inviteUrl };
        if (useIdem) await idempotencyStore.complete(p.userId, idemKey, 201, JSON.stringify(payload), { db: tx });
        return { kind: "ok" as const, payload };
      },
      { "app.users_admin_write": "true" },
    );
    if (result.kind === "replay") return c.body(result.body, result.status as 201);
    if (result.kind === "hash_mismatch") {
      return c.json(problem(422, "Unprocessable Entity", "Idempotency-Key reused with a different request", "idempotency_conflict"), 422);
    }
    if (result.kind === "idem_conflict") {
      return c.json(problem(409, "Conflict", "A request with this Idempotency-Key is in flight", "idempotency_conflict"), 409);
    }
    if (result.kind === "user_exists") {
      return c.json(problem(409, "Conflict", "email already has an account; use password reset", "user_exists"), 409);
    }
    return c.json(result.payload, 201);
  });

  app.delete("/v1/admin/invites/:id", async (c) => {
    const p = requireAdmin(c);
    if (!p) return c.json(problem(403, "Forbidden", "Admin role required", "forbidden"), 403);
    const ok = await withRlsContext(db.db, p, (tx) => inviteStore.revoke(c.req.param("id"), { db: tx }), {
      "app.users_admin_write": "true",
    });
    if (!ok) return c.json(problem(404, "Not Found", "Invite not found or already used", "not_found"), 404);
    return c.body(null, 204);
  });

  // Connections list: safe DTO projection (never the secret cipher).
  app.get("/v1/connections", async (c) => {
    const p = c.get("principal");
    const rows = await withRlsContext(db.db, p, (tx) =>
      connStore.listByUserView(p.userId, { limit: 50, db: tx }),
    );
    return c.json({ data: rows, has_more: false, next_cursor: null });
  });

  app.delete("/v1/connections/:id", async (c) => {
    const p = c.get("principal");
    const n = await withRlsContext(
      db.db,
      p,
      (tx) => connStore.remove(c.req.param("id"), p.userId, { db: tx }),
      p.isAdmin ? { "app.users_admin_write": "true" } : {},
    );
    if (n === 0) return c.json(problem(404, "Not Found", "Connection not found", "not_found"), 404);
    return c.body(null, 204);
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
