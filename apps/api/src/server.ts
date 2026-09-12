/**
 * llm-quota HTTP server bootstrap (Phase 7 + final security review, 2026-09).
 *
 * Implements `start()`: creates the DB handle (from `DATABASE_URL` + KEK),
 * attaches the Hono REST app (ADR-008) to a Node http/https listener via
 * `@hono/node-server`, enforces TLS 1.3 when `TLS_CERT_PATH`/`TLS_KEY_PATH`
 * are set (refusing local self-signed certs in production), runs the quota
 * collector scheduler, and adds: origin-allow-listed CORS with preflight
 * handling, HSTS/security headers, per-IP rate limiting on `/auth/*`, a
 * request-body size cap, and an ASVS V16-aligned audit logger.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  createDb,
  resolveDatabaseConfig,
  withRlsContext,
  PostgresConnectionStore,
  PostgresHistoryStore,
  PostgresIdempotencyStore,
  PostgresInstanceStore,
  PostgresAuthStore,
  PostgresQuotaStore,
  sweepSessions,
  type DbHandle,
  type ResolvedPrincipal,
} from "@llm-quota/db";
import {
  parseKekFromEnv,
  retentionBoundary,
  snapshotRetentionBoundary,
  type Dek,
} from "@llm-quota/core";
import { ProviderRegistry } from "@llm-quota/providers";
import { ollamaClaudeConnector } from "@llm-quota/connector-ollama-claude";
import { openRouterConnector } from "@llm-quota/connector-openrouter";
import { hashToken } from "@llm-quota/auth";
import { randomBytes } from "node:crypto";
import { createApiApp } from "./app.js";
import { runCollectPass } from "./collector.js";

export interface ServerConfig {
  port: number;
  env: string;
  db: DbHandle;
  kek: Dek;
  /** Restricted origin for CORS (from `WEB_ORIGIN`). */
  webOrigin?: string;
  /** Built SPA directory served same-origin (from `WEB_DIST_PATH`). */
  webDistPath?: string;
  /** TLS cert paths (set => HTTPS). */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  logger?: (msg: string) => void;
}

/** Parse a positive integer env value; empty/NaN falls back to the default. */
function envInt(name: string, def: number, min = 0): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= min ? n : def;
}

/** Refuse loading local self-signed certs in production (deploy policy). */function assertProdCertAllowed(certPath: string, env: string): void {
  if (env === "production" && /local\.(crt|key)/.test(certPath)) {
    throw new Error("Refusing local self-signed cert in NODE_ENV=production");
  }
}

/** Redact a secret-bearing query value (invite token) before logging. */
export function redactPath(path: string): string {
  return path.replace(/(token=)[A-Za-z0-9._~-]{8,}/gi, "$1[redacted]");
}

/** ASVS V16-aligned audit logger (structured; never logs request bodies). */
export function auditLogger(log = (line: string) => console.log(line)) {
  return (c: Context, next: Next) => {
    const start = Date.now();
    return next().then(() => {
      log(
        JSON.stringify({
          ts: new Date().toISOString(),
          method: c.req.method,
          path: redactPath(c.req.path),
          status: c.res.status,
          ms: Date.now() - start,
        }),
      );
    });
  };
}

/** Origins always allowed in local/dev (vite dev + preview ports). */
const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

const CORS_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS,QUERY";
const CORS_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Step-Up-Password, X-Request-Id";

/**
 * CORS restricted to an exact origin allow-list: the configured `webOrigin`
 * plus the local dev ports. The origin is echoed only on a match, preflights
 * are answered with the QUERY-capable verb list, and credentials stay off.
 */
export function corsOnce(webOrigin = "http://localhost:5173", includeDevOrigins = true) {
  const allowed = new Set([...(includeDevOrigins ? DEV_ORIGINS : []), ...(webOrigin ? [webOrigin] : [])]);
  return (c: Context, next: Next): Promise<void | Response> => {
    const origin = c.req.header("origin");
    if (origin && allowed.has(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", CORS_METHODS);
      c.header("Access-Control-Allow-Headers", CORS_HEADERS);
      c.header("Access-Control-Max-Age", "86400");
      return Promise.resolve(c.body(null, 204));
    }
    return next();
  };
}

/** Security headers; HSTS only makes sense on a TLS-terminated listener. */
export function securityHeaders(tls: boolean) {
  return (c: Context, next: Next) => {
    if (tls) c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    c.header("X-Content-Type-Options", "nosniff");
    // Auth responses carry session tokens: never cache them.
    if (c.req.path.startsWith("/auth/")) c.header("Cache-Control", "no-store");
    return next();
  };
}

/**
 * Fixed-window per-IP rate limiter (no deps) for the public `/auth/*` surface.
 * Rejects with RFC 7807 429 once `max` requests hit within `windowMs`.
 *
 * IP resolution only honours `X-Forwarded-For`/`X-Real-IP` when `TRUST_PROXY`
 * is enabled (the process sits behind a trusted reverse proxy); otherwise the
 * socket address is used, so a client cannot forge its budget with a header.
 */
export function rateLimitAuth(max = 30, windowMs = 60_000, trustProxy = false) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c: Context, next: Next) => {
    if (!c.req.path.startsWith("/auth/")) return next();
    const forwarded = trustProxy
      ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip")
      : undefined;
    const ip =
      forwarded ||
      (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket
        ?.remoteAddress ||
      "unknown";
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (hits.size > 10_000) {
      // Bounded memory: drop expired entries when the map grows large.
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (entry.count > max) {
      return c.json(
        {
          type: "https://api.llm-quota.dev/errors/rate-limited",
          title: "Too Many Requests",
          status: 429,
        },
        429,
      );
    }
    return next();
  };
}

/** Reject oversized request bodies before parsing (default 64 KB). */
export function bodyLimit(maxBytes = 64 * 1024) {
  return async (c: Context, next: Next) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > maxBytes) {
      return c.json(
        {
          type: "https://api.llm-quota.dev/errors/payload-too-large",
          title: "Payload Too Large",
          status: 413,
        },
        413,
      );
    }
    return next();
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve the built SPA from `WEB_DIST_PATH` (same-origin single-port deploy).
 *
 * Only GET/HEAD requests outside `/v1|/auth|/health` are served; anything else
 * falls through to the API (so unknown API paths still return RFC 7807 404, not
 * index.html). Dotfiles and source maps are never served, and the resolved path
 * must stay under the dist root (path-traversal guard). When no SPA is
 * configured, the API is unaffected.
 */
export function spaStatic(distPath: string | undefined) {
  const configuredRoot = distPath ? resolve(distPath) : null;
  return async (c: Context, next: Next) => {
    if (!configuredRoot) return next();
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") return next();
    const path = c.req.path;
    if (isApiSegment(path)) return next();

    let root: string;
    try {
      root = await realpath(configuredRoot);
    } catch {
      // Dist directory missing/misconfigured at runtime: fall through to the API.
      return next();
    }

    // Decode once; a malformed URI is treated as a miss, not a crash.
    let rel: string;
    try {
      rel = decodeURIComponent(path).replace(/^\/+/, "");
    } catch {
      return next();
    }
    if (rel.includes("\0") || /(^|\/)\.[^/]/.test(rel) || rel.endsWith(".map")) return next();

    const send = async (filePath: string, immutable: boolean): Promise<Response> => {
      const ext = filePath.slice(filePath.lastIndexOf("."));
      c.header("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
      c.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-store");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Frame-Options", "DENY");
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      const body = await readFile(filePath);
      return c.body(body, 200);
    };

    try {
      const candidate = await realpath(resolve(root, rel));
      // Resolve symlinks too, then confine the REAL path to the REAL root.
      if (candidate !== root && !candidate.startsWith(root + sep) && !candidate.startsWith(root + "/")) {
        return next();
      }
      const info = await stat(candidate);
      if (info.isFile()) return send(candidate, /\/assets\//.test(path));
    } catch {
      // not a file -> SPA fallback
    }
    // SPA fallback: unknown non-API GET => index.html (client-side routing).
    const indexPath = resolve(root, "index.html");
    try {
      if ((await stat(indexPath)).isFile()) return send(indexPath, false);
    } catch {
      // no built SPA present
    }
    return next();
  };
}

/** True for paths owned by the API (never served the SPA fallback). */
export function isApiSegment(path: string): boolean {
  return ["/v1", "/auth", "/health"].some((p) => path === p || path.startsWith(`${p}/`));
}

export interface Started {
  server: ServerType;
  address(): string;
  close(): Promise<void>;
}

/** Build + attach the Hono app and start an http/https server (no collector). */
export function buildServer(config: ServerConfig): Started {
  if (config.tlsCertPath) assertProdCertAllowed(config.tlsCertPath, config.env);
  if (config.tlsKeyPath) assertProdCertAllowed(config.tlsKeyPath, config.env);

  const tls = Boolean(config.tlsCertPath && config.tlsKeyPath);

  // Wrap the API app in a root app so CORS + audit middleware run BEFORE the
  // route handlers (registering `use` after routes would never execute them —
  // terminal route handlers win in Hono's registration-order composition).
  const app = createApiApp({ db: config.db, kek: config.kek, publicWebUrl: process.env.PUBLIC_WEB_URL });
  const root = new Hono();
  root.use("*", securityHeaders(tls));
  root.use("*", bodyLimit());
  root.use("*", rateLimitAuth(30, 60_000, process.env.TRUST_PROXY === "1"));
  root.use("*", corsOnce(config.webOrigin, config.env !== "production"));
  root.use("*", auditLogger(config.logger));
  // SPA static serving must be registered on the ROOT before the API route:
  // mounting inside `app` would put assets behind the bearer middleware. It
  // falls through for /v1|/auth|/health so those still return API responses.
  root.use("*", spaStatic(config.webDistPath));
  root.route("/", app);

  const server = serve(
    tls
      ? {
          fetch: root.fetch,
          port: config.port,
          hostname: "0.0.0.0",
          createServer: createHttpsServer,
          serverOptions: {
            cert: readFileSync(resolve(config.tlsCertPath!)),
            key: readFileSync(resolve(config.tlsKeyPath!)),
            minVersion: "TLSv1.3",
          } as HttpsServerOptions,
        }
      : {
          fetch: root.fetch,
          port: config.port,
          hostname: "0.0.0.0",
        },
  );

  const scheme = tls ? "https" : "http";
  const started: Started = {
    server: server as never,
    address: () => `${scheme}://0.0.0.0:${config.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };

  return started;
}

/** Build the provider registry with the v1 connectors (ADR-007). */
export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(ollamaClaudeConnector);
  registry.register(openRouterConnector);
  return registry;
}

/**
 * Quota collector scheduler: periodically enumerates every connection (cross-
 * tenant, via the `app.is_collector` RLS policy), then runs one collect pass
 * per owner context so FORCE RLS scopes the snapshot/aggregate writes. Also
 * applies the 12-month aggregate retention and the 7-day snapshot TTL.
 */
export function startCollector(
  db: DbHandle,
  kek: Dek,
  log: (msg: string) => void,
  intervalMs = Number(process.env.COLLECT_INTERVAL_MS ?? 60_000),
): () => void {
  const registry = createDefaultRegistry();
  const connStore = new PostgresConnectionStore(db.db, kek);
  // System principal used ONLY for the collector enumeration policy; never
  // derived from request input.
  const COLLECTOR: ResolvedPrincipal = {
    userId: "",
    role: "user",
    isAdmin: false,
    isSupervisorAdmin: false,
  };

  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const rows = await withRlsContext(
        db.db,
        COLLECTOR,
        (tx) => connStore.listAllForCollector({ db: tx }),
        { "app.is_collector": "true" },
      );
      for (const row of rows) {
        const owner: ResolvedPrincipal = {
          userId: row.userId,
          role: "user",
          isAdmin: false,
          isSupervisorAdmin: false,
        };
        try {
          await withRlsContext(db.db, owner, async (tx) => {
            const conn = await connStore.findById(row.id, row.userId);
            if (!conn) return;
            const connectorId = await connStore.providerConnectorId(row.providerId, { db: tx });
            if (!connectorId) return;
            const quotaStore = new PostgresQuotaStore(tx);
            const latest = await quotaStore.latestForConnection(row.id, { db: tx });
            const result = await runCollectPass(
              registry,
              new PostgresHistoryStore(tx),
              [
                {
                  id: conn.id,
                  userId: conn.userId,
                  providerId: row.providerId,
                  connectorId,
                  // v1 collections run on the daily calendar window (hourly
                  // interval); per-connection windows land with the settings UI.
                  window: "daily",
                  lastCollectedAt: latest?.readAt,
                  secret: conn.secret,
                },
              ],
              new Date(),
              200,
              quotaStore,
            );
            log(
              `[collector] connection=${conn.id} collected=${result.collected} skipped=${result.skipped} failed=${result.failed}`,
            );
          });
        } catch (err) {
          log(`[collector] connection=${row.id} error: ${String(err)}`);
        }
      }
      // Retention: aggregates 12 months, raw snapshots 7 days (ADR-005).
      const now = new Date();
      await withRlsContext(
        db.db,
        COLLECTOR,
        async (tx) => {
          const history = new PostgresHistoryStore(tx);
          const aggEvicted = await history.evictOlderThan(retentionBoundary(now));
          const snapEvicted = await history.evictSnapshotsOlderThan(
            snapshotRetentionBoundary(now),
          );
          if (aggEvicted || snapEvicted) {
            log(`[collector] retention: evicted ${aggEvicted} aggregates, ${snapEvicted} snapshots`);
          }
        },
        { "app.is_collector": "true" },
      );
      // Idempotency ledger: drop expired keys (bounded by TTL 24h). Runs under
      // the collector GUC so the maintenance delete policy applies on the pool.
      try {
        const swept = await withRlsContext(
          db.db,
          COLLECTOR,
          (tx) => new PostgresIdempotencyStore(tx).sweep(now),
          { "app.is_collector": "true" },
        );
        if (swept) log(`[collector] idempotency: swept ${swept} expired keys`);
      } catch (err) {
        log(`[collector] idempotency sweep error: ${String(err)}`);
      }
      // Auth state sweeps: stale login throttle rows, expired challenges and
      // rotated/expired sessions (E4/E5 retention).
      try {
        const authStore = new PostgresAuthStore(db.db, kek);
        const ttl = envInt("LOGIN_ATTEMPT_TTL_SECONDS", 86_400, 1);
        const sessionTtl = envInt("SESSION_RETENTION_SECONDS", 7 * 24 * 3600, 60);
        const attempts = await withRlsContext(db.db, COLLECTOR, (tx) => authStore.sweepLoginAttempts(ttl, now, { db: tx }), {
          "app.is_collector": "true",
        });
        const challenges = await withRlsContext(db.db, COLLECTOR, (tx) => authStore.sweepChallenges(now, { db: tx }), {
          "app.is_collector": "true",
        });
        const sessions = await withRlsContext(
          db.db,
          COLLECTOR,
          (tx) => sweepSessions(tx, now, sessionTtl),
          { "app.is_collector": "true" },
        );
        if (attempts || challenges || sessions) {
          log(`[collector] auth sweep: ${attempts} attempts, ${challenges} challenges, ${sessions} sessions`);
        }
      } catch (err) {
        log(`[collector] auth sweep error: ${String(err)}`);
      }
    } catch (err) {
      log(`[collector] pass error: ${String(err)}`);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void pass(), 5_000);
  first.unref?.();
  const timer = setInterval(() => void pass(), Math.max(10_000, intervalMs));
  timer.unref?.();

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * First-run bootstrap: mint + print a one-time setup token when the instance
 * has no admin. Idempotent-safe: only sets the token while setup is incomplete
 * (guarded by the SECURITY DEFINER `app_bootstrap_begin`).
 */
export async function bootstrapFirstRun(
  db: DbHandle,
  log: (msg: string) => void,
  ttlMinutes = 60,
): Promise<string | null> {
  try {
    const store = new PostgresInstanceStore(db.db);
    if (!(await store.setupRequired())) return null;
    const raw = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const ok = await store.beginBootstrap(hashToken(raw), expiresAt);
    if (!ok) return null;
    log("");
    log("================================================================");
    log("  llm-quota first-run setup");
    log("  Open the app and complete setup with this one-time code:");
    log(`    ${raw}`);
    log(`  It expires at ${expiresAt.toISOString()} and is shown only once.`);
    log("================================================================");
    log("");
    return raw;
  } catch (err) {
    log(`[llm-quota] bootstrap skipped: ${String(err)}`);
    return null;
  }
}

/** `start()` used by `pnpm start`; wires env config, DB + KEK, collector, server. */
export function start(): Started & { stopCollector(): void } {
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  const config = resolveDatabaseConfig(env);
  const db = createDb({ url: config.url, maxConnections: config.maxConnections });
  const kek = parseKekFromEnv(env);
  const envName = env.NODE_ENV ?? "development";
  const log = (line: string) => console.log(line);

  const started = buildServer({
    port,
    env: envName,
    db,
    kek,
    webOrigin: env.WEB_ORIGIN,
    webDistPath: env.WEB_DIST_PATH,
    tlsCertPath: env.TLS_CERT_PATH,
    tlsKeyPath: env.TLS_KEY_PATH,
    logger: log,
  });

  // First-run bootstrap: if the instance has no admin yet, mint a one-time
  // setup token, store only its hash, and print the plaintext ONCE to stdout so
  // the operator can complete /setup. Never persisted in env.
  void bootstrapFirstRun(db, log);

  const stopCollector =
    envName === "test"
      ? () => {}
      : startCollector(db, kek, log);

  log(`[llm-quota] API listening at ${started.address()}`);

  const close = async (): Promise<void> => {
    stopCollector();
    // Node >= 18.2: drop keep-alive sockets so close() resolves promptly.
    (started.server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    await started.close();
    await db.close();
  };

  return { ...started, close, stopCollector };
}
