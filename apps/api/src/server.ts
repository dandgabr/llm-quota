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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  PostgresQuotaStore,
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
import { createApiApp } from "./app.js";
import { runCollectPass } from "./collector.js";

export interface ServerConfig {
  port: number;
  env: string;
  db: DbHandle;
  kek: Dek;
  /** Restricted origin for CORS (from `WEB_ORIGIN`). */
  webOrigin?: string;
  /** TLS cert paths (set => HTTPS). */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  logger?: (msg: string) => void;
}

/** Refuse loading local self-signed certs in production (deploy policy). */
function assertProdCertAllowed(certPath: string, env: string): void {
  if (env === "production" && /local\.(crt|key)/.test(certPath)) {
    throw new Error("Refusing local self-signed cert in NODE_ENV=production");
  }
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
          path: c.req.path,
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
const CORS_HEADERS = "Authorization, Content-Type";

/**
 * CORS restricted to an exact origin allow-list: the configured `webOrigin`
 * plus the local dev ports. The origin is echoed only on a match, preflights
 * are answered with the QUERY-capable verb list, and credentials stay off.
 */
export function corsOnce(webOrigin = "http://localhost:5173") {
  const allowed = new Set([...DEV_ORIGINS, ...(webOrigin ? [webOrigin] : [])]);
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
    return next();
  };
}

/**
 * Fixed-window per-IP rate limiter (no deps) for the public `/auth/*` surface.
 * Rejects with RFC 7807 429 once `max` requests hit within `windowMs`.
 */
export function rateLimitAuth(max = 30, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c: Context, next: Next) => {
    if (!c.req.path.startsWith("/auth/")) return next();
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
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
        { type: "about:blank", title: "Too Many Requests", status: 429 },
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
        { type: "about:blank", title: "Payload Too Large", status: 413 },
        413,
      );
    }
    return next();
  };
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
  const app = createApiApp({ db: config.db, kek: config.kek });
  const root = new Hono();
  root.use("*", securityHeaders(tls));
  root.use("*", bodyLimit());
  root.use("*", rateLimitAuth());
  root.use("*", corsOnce(config.webOrigin));
  root.use("*", auditLogger(config.logger));
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
    tlsCertPath: env.TLS_CERT_PATH,
    tlsKeyPath: env.TLS_KEY_PATH,
    logger: log,
  });

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
