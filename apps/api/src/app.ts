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
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { DbHandle } from "@llm-quota/db";
import {
  PostgresConnectionStore,
  PostgresHistoryStore,
  PostgresQuotaStore,
  PostgresUserStore,
  PostgresInviteStore,
  PostgresIdempotencyStore,
  PostgresAuditStore,
  PostgresInstanceStore,
  PostgresAuthStore,
  listSessionsByUser,
  resolvePrincipal,
  revokeSession,
  revokeSessionByToken,
  revokeAllSessionsFor,
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
  hashToken,
  hashPassword,
  verifyPassword,
  dummyVerify,
  isValidPassword,
  buildTotpUri,
  verifyTotpWithStep,
  generateRecoveryCode,
  hashRecoveryCode,
  isValidRecoveryPepper,
  constantTimeHashEquals,
} from "@llm-quota/auth";

type Variables = { principal: ResolvedPrincipal; requestId: string };

/**
 * Public (unauthenticated) auth endpoints — an EXACT allow-list, never a bare
 * prefix, so the authenticated `/auth/*` routes (logout, password, MFA) still
 * pass through the bearer middleware.
 */
const PUBLIC_AUTH_PATHS = new Set([
  "/health",
  "/auth/setup/status",
  "/auth/setup",
  "/auth/invites/accept",
  "/auth/login",
  "/auth/login/mfa",
  "/auth/oidc/authorize",
]);

function isPublicPath(path: string): boolean {
  return PUBLIC_AUTH_PATHS.has(path) || path.startsWith("/health/");
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
  /** Idle session timeout in seconds (0 disables; absolute expiry still applies). */
  sessionIdleTtlSeconds?: number;
  /** Login throttle config (E4); defaults come from env. */
  loginThrottle?: {
    enabled: boolean;
    threshold: number;
    windowSeconds: number;
    baseSeconds: number;
    maxSeconds: number;
  };
}

type ProblemTypeKey = keyof typeof PROBLEM_TYPES;

function problem(
  status: number,
  title: string,
  detail: string | undefined,
  typeKey: ProblemTypeKey,
  invalidParams?: { name: string; reason: string }[],
): Problem {
  return {
    type: PROBLEM_TYPES[typeKey] ?? "https://api.llm-quota.dev/errors/internal",
    title,
    status,
    detail,
    invalid_params: invalidParams,
  };
}

/** RFC 7807 response helper (`application/problem+json`). */
function problemJson(
  c: { json: (body: unknown, status: number, headers: Record<string, string>) => Response },
  p: Problem,
): Response {
  return c.json(p, p.status, { "Content-Type": "application/problem+json" });
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
export function createApiApp({
  db,
  kek,
  now,
  enableDevSession,
  publicWebUrl,
  sessionIdleTtlSeconds,
  loginThrottle,
}: ApiAppOptions) {
  const app = new Hono<{ Variables: Variables }>();
  const connStore = new PostgresConnectionStore(db.db, kek ?? parseKekFromEnv());
  const historyStore = new PostgresHistoryStore(db.db);
  const quotaStore = new PostgresQuotaStore(db.db);
  const userStore = new PostgresUserStore(db.db);
  const inviteStore = new PostgresInviteStore(db.db);
  const idempotencyStore = new PostgresIdempotencyStore(db.db);
  const auditStore = new PostgresAuditStore(db.db);
  const instanceStore = new PostgresInstanceStore(db.db);
  const authStore = new PostgresAuthStore(db.db, kek ?? parseKekFromEnv());
  const webBase = publicWebUrl ?? process.env.PUBLIC_WEB_URL ?? "";

  // E4 login throttle config (env by default; override for tests).
  const throttle = loginThrottle ?? {
    enabled: process.env.LOCKOUT_ENABLED !== "0",
    threshold: Number(process.env.LOCKOUT_IP_THRESHOLD ?? 5),
    windowSeconds: Number(process.env.LOCKOUT_WINDOW_SECONDS ?? 900),
    baseSeconds: Number(process.env.LOCKOUT_BASE_SECONDS ?? 30),
    maxSeconds: Number(process.env.LOCKOUT_MAX_SECONDS ?? 3600),
  };
  const idleTtl = sessionIdleTtlSeconds ?? Number(process.env.SESSION_IDLE_TTL_SECONDS ?? 1800);
  const authPepper = process.env.AUTH_PEPPER ?? "";
  const recoveryPepper = process.env.RECOVERY_PEPPER ?? process.env.AUTH_PEPPER ?? "";
  const stepUpTtlSeconds = Number(process.env.STEP_UP_TTL_SECONDS ?? 300);
  const currentTime = () => now?.() ?? new Date();

  /** HMAC the normalized subject (email) with the auth pepper for the throttle key. */
  const createHmacKey = (domain: string, value: string): string => {
    const pepper = authPepper || "dev-only-insecure-pepper-change-me";
    return createHmac("sha256", pepper).update(`${domain}\u0000${value}`).digest("hex");
  };
  const subjectKeyFor = (email: string): string =>
    createHmacKey("subject", email.trim().toLowerCase());
  const ipHashFor = (ip: string): string => createHmacKey("ip", ip);
  const clientIp = (c: { req: { header(n: string): string | undefined }; env: unknown }): string => {
    const trust = process.env.TRUST_PROXY === "1";
    const forwarded = trust
      ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip")
      : undefined;
    return (
      forwarded ||
      (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ||
      "unknown"
    );
  };

  /** True when a successful password check should be refused by the lockout. */
  const isLocked = async (subjectKey: string, ipHash: string): Promise<Date | null> => {
    if (!throttle.enabled) return null;
    const row = await withRlsContext(
      db.db,
      { userId: "", role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => authStore.getLoginAttempt(subjectKey, ipHash, { db: tx }),
      { "app.is_auth_throttle": "true" },
    );
    if (!row?.lockedUntil) return null;
    return row.lockedUntil > currentTime() ? row.lockedUntil : null;
  };

  const recordFailure = async (
    subjectKey: string,
    ipHash: string,
  ): Promise<{ failedCount: number; lockedUntil: Date | null }> => {
    if (!throttle.enabled) return { failedCount: 0, lockedUntil: null };
    return withRlsContext(
      db.db,
      { userId: "", role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => authStore.recordLoginFailure(subjectKey, ipHash, throttle, { db: tx }),
      { "app.is_auth_throttle": "true" },
    );
  };

  const resetFailures = async (subjectKey: string): Promise<void> => {
    if (!throttle.enabled) return;
    await withRlsContext(
      db.db,
      { userId: "", role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => authStore.resetLoginAttempts(subjectKey, { db: tx }),
      { "app.is_auth_throttle": "true" },
    );
  };


  // Correlate every request with an audit event + log line. The client may pass
  // X-Request-Id only in a strict charset; otherwise a UUID is generated.
  app.use("*", async (c, next) => {
    const incoming = c.get("requestId");
    const requestId =
      incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    c.header("X-Request-Id", requestId);
    c.set("requestId", requestId);
    await next();
  });

  app.use("*", async (c, next) => {
    // Skip auth for public endpoints (health + auth, matched by segment).
    if (isPublicPath(c.req.path)) {
      return next();
    }
    const auth = c.req.header("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return problemJson(c, problem(401, "Unauthorized", "Missing bearer token", "unauthorized"));
    }
    const principal = await resolvePrincipal(
      db.db,
      auth.slice(7),
      now?.(),
      // Defense-in-depth: verify the stored HMAC when the server holds the
      // session-signing secret (guards a leaked hash table).
      process.env.SESSION_SECRET || undefined,
      { idleTtlSeconds: idleTtl },
    );
    if (!principal) {
      return problemJson(c, problem(401, "Unauthorized", "Invalid or expired session", "unauthorized"));
    }
    c.set("principal", principal);
    await next();
  });

  // RFC 7807 for anything that throws (malformed JSON, repo errors, ...).
  // Never leak the raw error message to the client (SQL/constraint details);
  // log it server-side and return a generic detail.
  app.onError((err, c) => {
    console.error("[llm-quota:api] unhandled error", err instanceof Error ? err.message : String(err));
    return problemJson(c, problem(500, "Internal Server Error", "Unexpected server error", "internal"));
  });

  // Public: health.
  app.get("/health", (c) => c.json({ ok: true, service: "llm-quota-api" }));

  app.get("/auth/oidc/authorize", (c) => {
    // Gated until server-side state/verifier persistence ships (ADR-009 note):
    // issuing challenge+state without binding them server-side invites CSRF.
    if (!devSessionsEnabled(enableDevSession)) {
      return problemJson(c, problem(403, "Forbidden", "OIDC flow not enabled", "forbidden"));
    }
    // PKCE: return only the challenge + state; NEVER the verifier.
    const { challenge } = generatePkcePair();
    const state = generateOidcState();
    return c.json({ code_challenge: challenge, state });
  });

  app.get("/auth/mfa/webauthn/challenge", (c) => {
    if (!devSessionsEnabled(enableDevSession)) {
      return problemJson(c, problem(403, "Forbidden", "MFA enrollment not enabled", "forbidden"));
    }
    return c.json({ challenge: generateWebAuthnChallenge() });
  });

  // ---- Onboarding (Phase C / ADR-015) -------------------------------------
  // Public: setup status + first-admin creation + invite accept. All gated by
  // SECURITY DEFINER authorizers (bootstrap token / invite token), never a GUC.
  app.get("/auth/setup/status", async (c) => {
    const required = await instanceStore.setupRequired();
    return c.json({ required });
  });

  app.post("/auth/setup", async (c) => {
    const secret = process.env.SESSION_SECRET ?? "";
    if (!isValidSessionSecret(secret)) {
      return problemJson(c, problem(500, "Server Error", "SESSION_SECRET must be ≥ 32 chars", "internal"));
    }
    const body = await c.req
      .json<{
        token?: string;
        email?: string;
        password?: string;
        firstName?: string;
        lastName?: string;
        locale?: string;
      }>()
      .catch(() => null);
    const email = (body?.email ?? "").trim().toLowerCase();
    const password = body?.password ?? "";
    if (!body?.token || !email.includes("@") || !isValidPassword(password)) {
      return problemJson(c, problem(400, "Bad Request", "token, valid email and password (≥12) required", "invalid_params"));
    }
    if (!(await instanceStore.setupRequired())) {
      return problemJson(c, problem(409, "Conflict", "Instance already initialized", "conflict"));
    }
    const tokenHash = hashToken(body.token);
    // Cheap token validation BEFORE the expensive KDF (anti-DoS).
    if (!(await instanceStore.bootstrapValid(tokenHash))) {
      return problemJson(c, problem(403, "Forbidden", "Invalid or expired setup token", "forbidden"));
    }
    const passwordHash = await hashPassword(password);
    const newId = await instanceStore.createFirstAdmin({
      tokenHash,
      email,
      passwordHash,
      firstName: body.firstName ?? null,
      lastName: body.lastName ?? null,
      locale: body.locale ?? "en",
    });
    if (!newId) {
      return problemJson(c, problem(403, "Forbidden", "Invalid or expired setup token", "forbidden"));
    }
    const user = await withRlsContext(
      db.db,
      { userId: newId, role: "admin", isAdmin: true, isSupervisorAdmin: true },
      (tx) => userStore.findById(newId, { db: tx }),
    );
    await withRlsContext(
      db.db,
      { userId: newId, role: "admin", isAdmin: true, isSupervisorAdmin: true },
      (tx) =>
        auditStore.record(
          {
            action: "auth.setup_completed",
            actorUserId: newId,
            actorRole: "admin",
            targetType: "user",
            targetId: newId,
            requestId: c.get("requestId"),
          },
          { db: tx },
        ),
    );
    // Issue a session for the new admin (owner RLS context).
    const { token, hash, signature } = issueSessionToken(secret);
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000);
    await withRlsContext(
      db.db,
      { userId: newId, role: "admin", isAdmin: true, isSupervisorAdmin: true },
      (tx) => createSession(tx, { userId: newId, tokenHash: hash, signature, expiresAt }),
    );
    return c.json({ token, expiresAt: expiresAt.toISOString(), user }, 201);
  });

  app.post("/auth/invites/accept", async (c) => {
    const secret = process.env.SESSION_SECRET ?? "";
    if (!isValidSessionSecret(secret)) {
      return problemJson(c, problem(500, "Server Error", "SESSION_SECRET must be ≥ 32 chars", "internal"));
    }
    const body = await c.req
      .json<{
        token?: string;
        password?: string;
        firstName?: string;
        lastName?: string;
        locale?: string;
      }>()
      .catch(() => null);
    const token = body?.token ?? "";
    const password = body?.password ?? "";
    if (!token || !isValidPassword(password)) {
      return problemJson(c, problem(400, "Bad Request", "token and password (≥12) required", "invalid_params"));
    }
    const tokenHash = hashToken(token);
    // Cheap invite validation BEFORE the expensive KDF (anti-DoS).
    const liveInvite = await withRlsContext(
      db.db,
      { userId: "", role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => inviteStore.findLiveByTokenHash(tokenHash, { db: tx }),
      { "app.is_invite": "true" },
    );
    if (!liveInvite) {
      return problemJson(c, problem(410, "Gone", "Invite is invalid, expired or already used", "invite_expired"));
    }
    const passwordHash = await hashPassword(password);
    const userId = await instanceStore.acceptInvite({
      tokenHash,
      passwordHash,
      firstName: body?.firstName ?? null,
      lastName: body?.lastName ?? null,
      locale: body?.locale ?? "en",
    });
    if (!userId) {
      return problemJson(c, problem(410, "Gone", "Invite is invalid, expired or already used", "invite_expired"));
    }
    const user = await withRlsContext(
      db.db,
      { userId, role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => userStore.findById(userId, { db: tx }),
    );
    const role: Role = user?.role ?? "user";
    await withRlsContext(
      db.db,
      { userId, role, isAdmin: role === "admin", isSupervisorAdmin: role !== "user" },
      (tx) =>
        auditStore.record(
          {
            action: "invite.accepted",
            actorUserId: userId,
            actorRole: role,
            targetType: "user",
            targetId: userId,
            requestId: c.get("requestId"),
          },
          { db: tx },
        ),
    );
    const { token: sessionToken, hash, signature } = issueSessionToken(secret);
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000);
    await withRlsContext(
      db.db,
      { userId, role, isAdmin: role === "admin", isSupervisorAdmin: role !== "user" },
      (tx) => createSession(tx, { userId, tokenHash: hash, signature, expiresAt }),
    );
    return c.json({ token: sessionToken, expiresAt: expiresAt.toISOString(), user }, 201);
  });

  // ---- Authentication (Phase D / ADR-016) ---------------------------------
  // Issue a 12h session for a verified user and audit the success.
  const issueLoginSession = async (
    c: { get(name: "requestId"): string },
    userId: string,
    role: Role,
    secret: string,
    opts: { stepUp?: boolean } = {},
  ): Promise<{ token: string; expiresAt: string; user: unknown }> => {
    const { token, hash, signature } = issueSessionToken(secret);
    const expiresAt = new Date(Date.now() + 12 * 3600 * 1000);
    // A completed password+MFA login counts as a step-up for sensitive actions.
    const stepUpAt = opts.stepUp === false ? null : new Date();
    await withRlsContext(
      db.db,
      { userId, role, isAdmin: role === "admin", isSupervisorAdmin: role !== "user" },
      (tx) => createSession(tx, { userId, tokenHash: hash, signature, expiresAt, stepUpAt }),
    );
    const user = await withRlsContext(
      db.db,
      { userId, role, isAdmin: role === "admin", isSupervisorAdmin: role !== "user" },
      (tx) => userStore.findById(userId, { db: tx }),
    );
    await withRlsContext(
      db.db,
      { userId, role, isAdmin: role === "admin", isSupervisorAdmin: role !== "user" },
      (tx) =>
        auditStore.record(
          {
            action: "auth.login_succeeded",
            actorUserId: userId,
            actorRole: role,
            targetType: "session",
            requestId: c.get("requestId"),
          },
          { db: tx },
        ),
    );
    return { token, expiresAt: expiresAt.toISOString(), user };
  };

  // Public login: password then (if enrolled) a single-use MFA challenge.
  app.post("/auth/login", async (c) => {
    const secret = process.env.SESSION_SECRET ?? "";
    if (!isValidSessionSecret(secret)) {
      return problemJson(c, problem(500, "Server Error", "SESSION_SECRET must be ≥ 32 chars", "internal"));
    }
    const body = await c.req
      .json<{ email?: string; password?: string }>()
      .catch(() => null);
    const email = (body?.email ?? "").trim().toLowerCase();
    const password = body?.password ?? "";
    if (!email || !password) {
      return problemJson(c, problem(400, "Bad Request", "email and password required", "invalid_params"));
    }
    const subjectKey = subjectKeyFor(email);
    const ipHash = ipHashFor(clientIp(c));
    const lockedUntil = await isLocked(subjectKey, ipHash);
    // Pre-auth lookup under app.is_auth + app.auth_email.
    const lookup = await withRlsContext(
      db.db,
      { userId: "", role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => authStore.findByEmail(email, { db: tx }),
      { "app.is_auth": "true", "app.auth_email": email },
    );
    const okUser = lookup && lookup.isActive && !lookup.deletedAt && lookup.passwordHash;
    // Always derive once (uniform timing) — even when locked or unknown.
    let passwordOk = false;
    if (lookup?.passwordHash) passwordOk = await verifyPassword(password, lookup.passwordHash);
    else await dummyVerify(password);
    // Lockout short-circuits AFTER the derivation so timing stays uniform.
    if (lockedUntil) {
      await withRlsContext(
        db.db,
        { userId: lookup?.userId ?? "", role: "user", isAdmin: false, isSupervisorAdmin: false },
        (tx) =>
          auditStore.record(
            {
              action: "auth.login_blocked",
              actorUserId: lookup?.userId ?? null,
              targetType: "session",
              metadata: { retry_after_s: Math.max(1, Math.ceil((lockedUntil.getTime() - currentTime().getTime()) / 1000)) },
              requestId: c.get("requestId"),
            },
            { db: tx },
          ),
        { "app.is_audit": "true" },
      );
      return problemJson(c, problem(401, "Unauthorized", "Invalid credentials", "unauthorized"));
    }
    if (!okUser || !passwordOk) {
      const outcome = await recordFailure(subjectKey, ipHash);
      await withRlsContext(
        db.db,
        { userId: lookup?.userId ?? "", role: "user", isAdmin: false, isSupervisorAdmin: false },
        (tx) =>
          auditStore.record(
            {
              action: outcome.lockedUntil ? "auth.lockout_triggered" : "auth.login_failed",
              actorUserId: lookup?.userId ?? null,
              targetType: "session",
              metadata: { failed_count: outcome.failedCount },
              requestId: c.get("requestId"),
            },
            { db: tx },
          ),
        { "app.is_audit": "true" },
      );
      return problemJson(c, problem(401, "Unauthorized", "Invalid credentials", "unauthorized"));
    }
    const userId = lookup!.userId;
    // Is MFA enrolled (verified TOTP)?
    const totp = await withRlsContext(
      db.db,
      { userId, role: lookup!.role as Role, isAdmin: false, isSupervisorAdmin: false },
      (tx) => authStore.getTotpSecret(userId, { db: tx }),
    );
    if (totp?.verified) {
      const challengeId = await withRlsContext(
        db.db,
        { userId, role: lookup!.role as Role, isAdmin: false, isSupervisorAdmin: false },
        (tx) => authStore.createChallenge(userId, "totp", 300, { db: tx }),
      );
      return c.json({ status: "mfa_required", methods: ["totp", "recovery"], challenge: challengeId });
    }
    // No MFA: reset the throttle and issue the session.
    await resetFailures(subjectKey);
    const session = await issueLoginSession(c, userId, lookup!.role as Role, secret);
    return c.json(session);
  });

  app.post("/auth/login/mfa", async (c) => {
    const secret = process.env.SESSION_SECRET ?? "";
    if (!isValidSessionSecret(secret)) {
      return problemJson(c, problem(500, "Server Error", "SESSION_SECRET must be ≥ 32 chars", "internal"));
    }
    const body = await c.req
      .json<{ challenge?: string; code?: string }>()
      .catch(() => null);
    const challengeId = body?.challenge ?? "";
    const code = (body?.code ?? "").trim();
    if (!challengeId || !code) {
      return problemJson(c, problem(400, "Bad Request", "challenge and code required", "invalid_params"));
    }
    // Resolve the challenge owner (SECURITY DEFINER, outside RLS), then scope
    // the challenge/recovery/TOTP reads to that user.
    const owner = await withRlsContext(
      db.db,
      { userId: "", role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => authStore.challengeOwner(challengeId, { db: tx }),
    );
    if (!owner) {
      return problemJson(c, problem(410, "Gone", "Challenge expired or already used", "mfa_required"));
    }
    const userId = owner;
    const MAX_ATTEMPTS = 5;
    const outcome = await withRlsContext(
      db.db,
      { userId, role: "user", isAdmin: false, isSupervisorAdmin: false },
      async (tx) => {
        const challenge = await authStore.getChallenge(challengeId, { db: tx });
        if (!challenge || challenge.consumedAt || challenge.expiresAt < new Date()) {
          return { kind: "gone" as const };
        }
        if (challenge.attempts >= MAX_ATTEMPTS) return { kind: "throttled" as const };
        const totp = await authStore.getTotpSecret(userId, { db: tx });
        // Validate BEFORE consuming so a typo does not burn the challenge.
        if (totp?.verified) {
          const verify = verifyTotpWithStep(totp.secret, code, { lastUsedStep: totp.lastUsedStep ?? undefined });
          if (verify.valid && verify.step !== undefined) {
            // Atomic CAS: only consume the step if it is newer than the stored one.
            const advanced = await authStore.verifyTotpSecret(userId, verify.step, { db: tx });
            if (!advanced) return { kind: "bad" as const };
            await authStore.consumeChallenge(challengeId, { db: tx });
            return { kind: "ok" as const };
          }
        }
        // Recovery is fail-closed: no valid pepper -> config error, never a fallback.
        if (!isValidRecoveryPepper(recoveryPepper)) return { kind: "config" as const };
        const candidateHash = hashRecoveryCode(code, recoveryPepper, userId);
        const used = await authStore.consumeRecoveryCode(userId, candidateHash, {
          db: tx,
          equals: constantTimeHashEquals,
        });
        if (used) {
          await authStore.consumeChallenge(challengeId, { db: tx });
          return { kind: "ok" as const, recovery: true };
        }
        await authStore.bumpAttempts(challengeId, { db: tx });
        return { kind: "bad" as const };
      },
      { "app.is_auth_challenge": "true", "app.challenge_user_id": userId },
    );
    if (outcome.kind === "config") {
      return problemJson(c, problem(500, "Server Error", "Recovery is not configured", "internal"));
    }
    if (outcome.kind === "gone") {
      return problemJson(c, problem(410, "Gone", "Challenge expired or already used", "mfa_required"));
    }
    if (outcome.kind === "throttled") {
      return problemJson(c, problem(429, "Too Many Requests", "Too many attempts", "account_locked"));
    }
    if (outcome.kind === "bad") {
      await withRlsContext(
        db.db,
        { userId, role: "user", isAdmin: false, isSupervisorAdmin: false },
        (tx) =>
          auditStore.record(
            {
              action: "auth.login_failed",
              actorUserId: userId,
              targetType: "session",
              metadata: { stage: "mfa" },
              requestId: c.get("requestId"),
            },
            { db: tx },
          ),
        { "app.user_id": userId },
      );
      return problemJson(c, problem(401, "Unauthorized", "Invalid code", "unauthorized"));
    }
    const account = await withRlsContext(
      db.db,
      { userId, role: "user", isAdmin: false, isSupervisorAdmin: false },
      (tx) => authStore.findById(userId, { db: tx }),
      { "app.user_id": userId },
    );
    const role: Role = (account?.role as Role) ?? "user";
    if (outcome.recovery) {
      await withRlsContext(
        db.db,
        { userId, role, isAdmin: role === "admin", isSupervisorAdmin: role !== "user" },
        (tx) =>
          auditStore.record(
            {
              action: "mfa.recovery_code_used",
              actorUserId: userId,
              actorRole: role,
              targetType: "user",
              targetId: userId,
              requestId: c.get("requestId"),
            },
            { db: tx },
          ),
      );
    }
    // Full MFA success clears the login throttle for this subject.
    await resetFailures(subjectKeyFor(account?.email ?? ""));
    const session = await issueLoginSession(c, userId, role, secret);
    return c.json(session);
  });

  app.post("/auth/logout", async (c) => {
    const p = c.get("principal");
    const authHeader = c.req.header("authorization") ?? "";
    // Revoke the current session (match by token hash).
    const token = authHeader.slice(7);
    await withRlsContext(db.db, p, (tx) =>
      revokeSessionByToken(tx, hashToken(token), p.userId),
    );
    await withRlsContext(
      db.db,
      p,
      (tx) =>
        auditStore.record(
          {
            action: "auth.logout",
            actorUserId: p.userId,
            actorRole: p.role,
            targetType: "session",
            requestId: c.get("requestId"),
          },
          { db: tx },
        ),
    );
    return c.body(null, 204);
  });

  app.post("/auth/password/change", async (c) => {
    const p = c.get("principal");
    const body = await c.req
      .json<{ currentPassword?: string; newPassword?: string }>()
      .catch(() => null);
    if (!body?.currentPassword || !isValidPassword(body.newPassword ?? "")) {
      return problemJson(c, problem(400, "Bad Request", "current and new password (≥12) required", "invalid_params"));
    }
    const current = await withRlsContext(
      db.db,
      p,
      (tx) => authStore.findById(p.userId, { db: tx }),
    );
    void current;
    // Verify against the caller's own credential by id.
    const stored = await withRlsContext(
      db.db,
      p,
      (tx) => userStore.getPasswordHash(p.userId, { db: tx }),
      { "app.is_self_password_change": "true" },
    );
    const ok = stored ? await verifyPassword(body.currentPassword, stored) : false;
    if (!ok) {
      return problemJson(c, problem(401, "Unauthorized", "Current password is incorrect", "unauthorized"));
    }
    const newHash = await hashPassword(body.newPassword!);
    await withRlsContext(
      db.db,
      p,
      (tx) => userStore.setPassword(p.userId, newHash, { db: tx }),
      { "app.is_self_password_change": "true" },
    );
    await withRlsContext(
      db.db,
      p,
      (tx) =>
        auditStore.record(
          {
            action: "user.password_reset",
            actorUserId: p.userId,
            actorRole: p.role,
            targetType: "user",
            targetId: p.userId,
            metadata: { self: true },
            requestId: c.get("requestId"),
          },
          { db: tx },
        ),
    );
    return c.body(null, 204);
  });

  // E3 step-up: sensitive MFA operations require the current password (or a
  // recent step-up within STEP_UP_TTL_SECONDS). Never derived from the client.
  const requireStepUp = async (
    c: { get(name: "principal"): ResolvedPrincipal; get(name: "requestId"): string },
    p: ResolvedPrincipal,
    currentPassword: string | undefined,
  ): Promise<{ ok: true } | { ok: false; status: number; problem: Problem }> => {
    const recent =
      p.stepUpAt && currentTime().getTime() - p.stepUpAt.getTime() <= stepUpTtlSeconds * 1000;
    if (recent) return { ok: true };
    if (!currentPassword) {
      return { ok: false, status: 400, problem: problem(400, "Bad Request", "currentPassword required", "invalid_params") };
    }
    const stored = await withRlsContext(
      db.db,
      p,
      (tx) => userStore.getPasswordHash(p.userId, { db: tx }),
      { "app.is_self_password_change": "true" },
    );
    const ok = stored ? await verifyPassword(currentPassword, stored) : false;
    if (!ok) {
      await dummyVerify(currentPassword);
      await withRlsContext(
        db.db,
        p,
        (tx) =>
          auditStore.record(
            { action: "auth.step_up_failed", actorUserId: p.userId, actorRole: p.role, targetType: "user", targetId: p.userId, requestId: c.get("requestId") },
            { db: tx },
          ),
      );
      return { ok: false, status: 401, problem: problem(401, "Unauthorized", "Password is incorrect", "unauthorized") };
    }
    return { ok: true };
  };

  // MFA enrollment (authenticated; step-up required).
  app.post("/auth/mfa/totp/enroll", async (c) => {
    const p = c.get("principal");
    const body = await c.req.json<{ currentPassword?: string }>().catch(() => null);
    const gate = await requireStepUp(c, p, body?.currentPassword);
    if (!gate.ok) return problemJson(c, gate.problem);
    const secret = generateTotpSecret();
    await withRlsContext(
      db.db,
      p,
      async (tx) => {
        await authStore.setTotpSecret(p.userId, secret, { db: tx });
        // A new enrollment invalidates any old recovery codes.
        await authStore.setRecoveryCodes(p.userId, [], { db: tx });
      },
      { "app.is_self_password_change": "true" },
    );
    const uri = buildTotpUri({
      secretBase64Url: secret,
      accountName: p.userId,
      issuer: process.env.TOTP_ISSUER ?? "llm-quota",
    });
    return c.json({ secret, uri });
  });

  app.post("/auth/mfa/totp/verify", async (c) => {
    const p = c.get("principal");
    const body = await c.req.json<{ code?: string }>().catch(() => null);
    const code = (body?.code ?? "").trim();
    if (!code) return problemJson(c, problem(400, "Bad Request", "code required", "invalid_params"));
    if (!isValidRecoveryPepper(recoveryPepper)) {
      return problemJson(c, problem(500, "Server Error", "Recovery is not configured", "internal"));
    }
    const result = await withRlsContext(
      db.db,
      p,
      async (tx) => {
        const totp = await authStore.getTotpSecret(p.userId, { db: tx });
        if (!totp) return { kind: "no_secret" as const };
        const verify = verifyTotpWithStep(totp.secret, code, { lastUsedStep: totp.lastUsedStep ?? undefined });
        if (!verify.valid || verify.step === undefined) return { kind: "bad" as const };
        const advanced = await authStore.verifyTotpSecret(p.userId, verify.step, { db: tx });
        if (!advanced) return { kind: "bad" as const };
        return { kind: "ok" as const };
      },
      { "app.is_self_password_change": "true" },
    );
    if (result.kind === "no_secret") {
      return problemJson(c, problem(409, "Conflict", "Start enrollment first", "conflict"));
    }
    if (result.kind === "bad") {
      return problemJson(c, problem(401, "Unauthorized", "Invalid code", "unauthorized"));
    }
    // Generate high-entropy recovery codes (shown once, HMAC+pepper at rest).
    const codes = Array.from({ length: 10 }, () => generateRecoveryCode());
    await withRlsContext(
      db.db,
      p,
      (tx) =>
        authStore.setRecoveryCodes(
          p.userId,
          codes.map((code2) => hashRecoveryCode(code2, recoveryPepper, p.userId)),
          { db: tx },
        ),
      { "app.is_self_password_change": "true" },
    );
    await withRlsContext(
      db.db,
      p,
      (tx) =>
        auditStore.record(
          { action: "mfa.enrolled", actorUserId: p.userId, actorRole: p.role, targetType: "user", targetId: p.userId, requestId: c.get("requestId") },
          { db: tx },
        ),
    );
    return c.json({ ok: true, recoveryCodes: codes });
  });

  app.post("/auth/mfa/recovery-codes/regenerate", async (c) => {
    const p = c.get("principal");
    const body = await c.req.json<{ currentPassword?: string }>().catch(() => null);
    const gate = await requireStepUp(c, p, body?.currentPassword);
    if (!gate.ok) return problemJson(c, gate.problem);
    if (!isValidRecoveryPepper(recoveryPepper)) {
      return problemJson(c, problem(500, "Server Error", "Recovery is not configured", "internal"));
    }
    const totp = await withRlsContext(db.db, p, (tx) => authStore.getTotpSecret(p.userId, { db: tx }));
    if (!totp?.verified) {
      return problemJson(c, problem(409, "Conflict", "Enroll MFA before generating recovery codes", "conflict"));
    }
    const codes = Array.from({ length: 10 }, () => generateRecoveryCode());
    await withRlsContext(
      db.db,
      p,
      (tx) =>
        authStore.setRecoveryCodes(
          p.userId,
          codes.map((code2) => hashRecoveryCode(code2, recoveryPepper, p.userId)),
          { db: tx },
        ),
      { "app.is_self_password_change": "true" },
    );
    await withRlsContext(
      db.db,
      p,
      (tx) =>
        auditStore.record(
          { action: "mfa.recovery_codes_regenerated", actorUserId: p.userId, actorRole: p.role, targetType: "user", targetId: p.userId, requestId: c.get("requestId") },
          { db: tx },
        ),
    );
    return c.json({ recoveryCodes: codes });
  });

  app.delete("/auth/mfa/totp", async (c) => {
    const p = c.get("principal");
    // DELETE bodies are unreliable through proxies: accept the step-up password
    // via header as a fallback.
    const body = await c.req.json<{ currentPassword?: string }>().catch(() => null);
    const stepUpPassword = body?.currentPassword ?? c.req.header("x-step-up-password");
    const gate = await requireStepUp(c, p, stepUpPassword);
    if (!gate.ok) return problemJson(c, gate.problem);
    await withRlsContext(
      db.db,
      p,
      async (tx) => {
        await authStore.deleteTotpSecret(p.userId, { db: tx });
        await authStore.setRecoveryCodes(p.userId, [], { db: tx });
      },
      { "app.is_self_password_change": "true" },
    );
    await withRlsContext(
      db.db,
      p,
      (tx) =>
        auditStore.record(
          { action: "mfa.disabled", actorUserId: p.userId, actorRole: p.role, targetType: "user", targetId: p.userId, requestId: c.get("requestId") },
          { db: tx },
        ),
    );
    return c.body(null, 204);
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
      return problemJson(c, problem(403, "Forbidden", "Supervisor role required", "forbidden"));
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
    if (!p) return problemJson(c, problem(403, "Forbidden", "Admin role required", "forbidden"));
    const body = await c.req.json<{ role?: Role; isActive?: boolean }>().catch(() => null);
    if (!body || (body.role === undefined && body.isActive === undefined)) {
      return problemJson(c, problem(400, "Bad Request", "role or isActive required", "invalid_params"));
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
          await auditStore.record(
            {
              action: "user.role_changed",
              actorUserId: p.userId,
              actorRole: p.role,
              targetType: "user",
              targetId: target,
              metadata: { role: body.role },
              requestId: c.get("requestId"),
            },
            { db: tx },
          );
        }
        if (body.isActive !== undefined) {
          const view = await userStore.setActive(target, body.isActive, { db: tx });
          if (!view) return { kind: "not_found" as const };
          await auditStore.record(
            {
              action: body.isActive ? "user.unblocked" : "user.blocked",
              actorUserId: p.userId,
              actorRole: p.role,
              targetType: "user",
              targetId: target,
              requestId: c.get("requestId"),
            },
            { db: tx },
          );
        }
        const view = await userStore.findById(target, { db: tx });
        return { kind: "ok" as const, view };
      },
      { "app.users_admin_write": "true" },
    );
    if (result.kind === "last_admin") {
      return problemJson(c, problem(409, "Conflict", "cannot remove the last active admin", "last_admin"));
    }
    if (result.kind === "self") {
      return problemJson(c, problem(409, "Conflict", "cannot change your own role or block yourself", "conflict"));
    }
    if (result.kind === "not_found") {
      return problemJson(c, problem(404, "Not Found", "User not found", "not_found"));
    }
    return c.json(result.view);
  });

  app.delete("/v1/admin/users/:id", async (c) => {
    const p = requireAdmin(c);
    if (!p) return problemJson(c, problem(403, "Forbidden", "Admin role required", "forbidden"));
    const target = c.req.param("id");
    if (target === p.userId) {
      return problemJson(c, problem(409, "Conflict", "cannot delete yourself", "conflict"));
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
        if (ok) {
          await auditStore.record(
            {
              action: "user.deleted",
              actorUserId: p.userId,
              actorRole: p.role,
              targetType: "user",
              targetId: target,
              requestId: c.get("requestId"),
            },
            { db: tx },
          );
        }
        return ok ? ("ok" as const) : ("not_found" as const);
      },
      { "app.users_admin_write": "true" },
    );
    if (result === "last_admin") {
      return problemJson(c, problem(409, "Conflict", "cannot delete the last active admin", "last_admin"));
    }
    if (result === "not_found") {
      return problemJson(c, problem(404, "Not Found", "User not found", "not_found"));
    }
    return c.body(null, 204);
  });

  // ---- Invites ------------------------------------------------------------
  app.get("/v1/admin/invites", async (c) => {
    const p = requireAdmin(c);
    if (!p) return problemJson(c, problem(403, "Forbidden", "Admin role required", "forbidden"));
    const rows = await withRlsContext(db.db, p, (tx) => inviteStore.list({ db: tx }), {
      "app.users_admin_write": "true",
    });
    return c.json({ data: rows, has_more: false, next_cursor: null });
  });

  app.post("/v1/admin/invites", async (c) => {
    const p = requireAdmin(c);
    if (!p) return problemJson(c, problem(403, "Forbidden", "Admin role required", "forbidden"));
    const body = await c.req
      .json<{ email?: string; role?: Role; expiresInHours?: number }>()
      .catch(() => null);
    const email = (body?.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return problemJson(c, problem(400, "Bad Request", "valid email required", "invalid_params"));
    }
    const role: Role = body?.role && ["user", "supervisor", "admin"].includes(body.role) ? body.role : "user";
    const expiresInHours = Math.min(Math.max(1, body?.expiresInHours ?? 72), 168);
    // Idempotency: a retry with the same key replays the original response
    // instead of minting a second invite. Run under the admin RLS context.
    const idemKey = c.req.header("idempotency-key");
    const useIdem = validIdempotencyKey(idemKey);
    // Only hash the body when idempotency is actually used.
    const rHash = useIdem ? requestHash("POST", "/v1/admin/invites", { email, role, expiresInHours }) : "";
    const result = await withRlsContext(
      db.db,
      p,
      async (tx) => {
        if (useIdem) {
          const claim = await idempotencyStore.claim(p.userId, idemKey, rHash, 86_400, { db: tx });
          if (claim.kind === "replay") {
            return { kind: "replay" as const, status: claim.status ?? 201, body: claim.body ?? "{}" };
          }
          if (claim.kind === "hash_mismatch") {
            // The claim belongs to a different request; release so a correct
            // retry (or the original body) can proceed.
            await idempotencyStore.release(p.userId, idemKey, { db: tx });
            return { kind: "hash_mismatch" as const };
          }
          if (claim.kind === "conflict") return { kind: "idem_conflict" as const };
        }
        if (await inviteStore.emailInUse(email, { db: tx })) {
          // Do not leave a claimed-but-uncompleted key for a rejected request.
          if (useIdem) await idempotencyStore.release(p.userId, idemKey, { db: tx });
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
        await auditStore.record(
          {
            action: "invite.created",
            actorUserId: p.userId,
            actorRole: p.role,
            targetType: "invite",
            targetId: invite.id,
            metadata: { email, role },
            requestId: c.get("requestId"),
          },
          { db: tx },
        );
        if (useIdem) await idempotencyStore.complete(p.userId, idemKey, 201, JSON.stringify(payload), { db: tx });
        return { kind: "ok" as const, payload };
      },
      { "app.users_admin_write": "true" },
    );
    if (result.kind === "replay") return c.body(result.body, result.status as 201);
    if (result.kind === "hash_mismatch") {
      return problemJson(c, problem(422, "Unprocessable Entity", "Idempotency-Key reused with a different request", "idempotency_conflict"));
    }
    if (result.kind === "idem_conflict") {
      return problemJson(c, problem(409, "Conflict", "A request with this Idempotency-Key is in flight", "idempotency_conflict"));
    }
    if (result.kind === "user_exists") {
      return problemJson(c, problem(409, "Conflict", "email already has an account; use password reset", "user_exists"));
    }
    return c.json(result.payload, 201);
  });

  app.delete("/v1/admin/invites/:id", async (c) => {
    const p = requireAdmin(c);
    if (!p) return problemJson(c, problem(403, "Forbidden", "Admin role required", "forbidden"));
    const inviteId = c.req.param("id");
    const ok = await withRlsContext(
      db.db,
      p,
      async (tx) => {
        const revoked = await inviteStore.revoke(inviteId, { db: tx });
        if (revoked) {
          await auditStore.record(
            {
              action: "invite.revoked",
              actorUserId: p.userId,
              actorRole: p.role,
              targetType: "invite",
              targetId: inviteId,
              requestId: c.get("requestId"),
            },
            { db: tx },
          );
        }
        return revoked;
      },
      { "app.users_admin_write": "true" },
    );
    if (!ok) return problemJson(c, problem(404, "Not Found", "Invite not found or already used", "not_found"));
    return c.body(null, 204);
  });

  app.delete("/v1/admin/users/:id/mfa", async (c) => {
    const p = requireAdmin(c);
    if (!p) return problemJson(c, problem(403, "Forbidden", "Admin role required", "forbidden"));
    const body = await c.req.json<{ currentPassword?: string }>().catch(() => null);
    const gate = await requireStepUp(c, p, body?.currentPassword);
    if (!gate.ok) return problemJson(c, gate.problem);
    const target = c.req.param("id");
    await withRlsContext(
      db.db,
      p,
      async (tx) => {
        await authStore.deleteTotpSecret(target, { db: tx });
        await authStore.setRecoveryCodes(target, [], { db: tx });
        await revokeAllSessionsFor(tx, target);
      },
      { "app.users_admin_write": "true" },
    );
    await withRlsContext(
      db.db,
      p,
      (tx) =>
        auditStore.record(
          { action: "mfa.admin_reset", actorUserId: p.userId, actorRole: p.role, targetType: "user", targetId: target, requestId: c.get("requestId") },
          { db: tx },
        ),
    );
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
    const connId = c.req.param("id");
    const n = await withRlsContext(
      db.db,
      p,
      async (tx) => {
        const removed = await connStore.remove(connId, p.userId, { db: tx });
        if (removed) {
          await auditStore.record(
            {
              action: "connection.deleted",
              actorUserId: p.userId,
              actorRole: p.role,
              targetType: "connection",
              targetId: connId,
              requestId: c.get("requestId"),
            },
            { db: tx },
          );
        }
        return removed;
      },
      p.isAdmin ? { "app.users_admin_write": "true" } : {},
    );
    if (n === 0) return problemJson(c, problem(404, "Not Found", "Connection not found", "not_found"));
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
      return problemJson(c, problem(400, "Bad Request", "providerId and secret are required", "invalid_params"));
    }
    const p = c.get("principal");
    try {
      const view = await withRlsContext(db.db, p, async (tx) => {
        const created = await connStore.createAndReturnView({
          userId: p.userId,
          providerId: body.providerId!,
          label: body.label ?? "unnamed",
          connectionType: body.connectionType ?? "api",
          secret,
          db: tx,
        });
        await auditStore.record(
          {
            action: "connection.created",
            actorUserId: p.userId,
            actorRole: p.role,
            targetType: "connection",
            targetId: created.id,
            metadata: { providerKey: created.providerKey },
            requestId: c.get("requestId"),
          },
          { db: tx },
        );
        return created;
      });
      return c.json(view, 201);
    } catch {
      // Unknown providerId trips the FK constraint -> client error, not 500.
      return problemJson(c, problem(400, "Bad Request", "Connection rejected", "invalid_params"));
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
      return problemJson(c, problem(403, "Forbidden", "Supervisor role required", "forbidden"));
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

  // ---- Audit trail (Phase B / ADR-014) ------------------------------------
  app.get("/v1/audit", async (c) => {
    const p = c.get("principal");
    if (!hasRole(p.role, "supervisor")) {
      return problemJson(c, problem(403, "Forbidden", "Supervisor role required", "forbidden"));
    }
    const q = c.req.query();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (q.actor && !UUID_RE.test(q.actor)) {
      return problemJson(c, problem(400, "Bad Request", "actor must be a UUID", "invalid_params"));
    }
    const fromDate = q.from ? new Date(q.from) : undefined;
    const toDate = q.to ? new Date(q.to) : undefined;
    if ((q.from && Number.isNaN(fromDate!.getTime())) || (q.to && Number.isNaN(toDate!.getTime()))) {
      return problemJson(c, problem(400, "Bad Request", "from/to must be ISO instants", "invalid_params"));
    }
    const rawLimit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    const limit = rawLimit !== undefined && !Number.isNaN(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
    const cursor = q.cursor;
    let beforeOccurredAt: Date | undefined;
    let beforeId: string | undefined;
    if (cursor) {
      const [ts, id] = cursor.split("|");
      const parsed = ts ? new Date(ts) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || !id || !UUID_RE.test(id)) {
        return problemJson(c, problem(400, "Bad Request", "invalid cursor", "invalid_params"));
      }
      beforeOccurredAt = parsed;
      beforeId = id;
    }
    const result = await withRlsContext(
      db.db,
      p,
      (tx) =>
        auditStore.list(
          {
            actorUserId: q.actor,
            action: q.action,
            targetType: q.target_type,
            from: fromDate,
            to: toDate,
            beforeOccurredAt,
            beforeId,
            limit,
          },
          { db: tx },
        ),
      { "app.is_supervisor_admin": "true" },
    );
    return c.json({ data: result.data, has_more: result.nextCursor !== null, next_cursor: result.nextCursor });
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
      return problemJson(c, problem(400, "Bad Request", "granularity must be daily|weekly|monthly", "invalid_params"));
    }
    // Defaults: no bounds => the full retained window (12 months) is returned.
    // Bounds are granularity-prefixed so the lexicographic range matches the
    // stored window keys.
    const fromRaw = pick("from");
    const toRaw = pick("to");
    const from = fromRaw ? windowBound(granularity, fromRaw) : null;
    const to = toRaw ? windowBound(granularity, toRaw) : null;
    if ((fromRaw && !from) || (toRaw && !to)) {
      return problemJson(c, problem(400, "Bad Request", "from/to must be an ISO instant", "invalid_params"));
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
    if (n === 0) return problemJson(c, problem(404, "Not Found", "Session not found", "not_found"));
    return c.json({ ok: true });
  });

  return app;
}
