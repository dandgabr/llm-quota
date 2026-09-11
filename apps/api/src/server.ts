/**
 * llm-quota HTTP server bootstrap (Phase 7).
 *
 * Implements `start()`: creates the DB handle (from `DATABASE_URL` + KEK),
 * attaches the Hono REST app (ADR-008) to a Node http/https listener via
 * `@hono/node-server`, supports TLS 1.3 (Phase 7 policy) when
 * `TLS_CERT_PATH`/`TLS_KEY_PATH` are set, and refuses local self-signed certs
 * in production. Adds restricted CORS + an ASVS V16-aligned audit logger.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { Context, Next } from "hono";
import { createDb, resolveDatabaseConfig, type DbHandle } from "@llm-quota/db";
import { parseKekFromEnv, type Dek } from "@llm-quota/core";
import { createApiApp } from "./app.js";

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

/** CORS restricted to a single origin (default dev). */
export function corsOnce(webOrigin = "http://localhost:5173") {
  return (c: Context, next: Next) => {
    if (!c.res.headers.has("access-control-allow-origin")) {
      c.header("Access-Control-Allow-Origin", webOrigin);
      c.header("Vary", "Origin");
    }
    return next();
  };
}

export interface Started {
  server: ServerType;
  address(): string;
  close(): Promise<void>;
}

/** Build + attach the Hono app and start an http/https server. */
export function buildServer(config: ServerConfig): Started {
  if (config.tlsCertPath) assertProdCertAllowed(config.tlsCertPath, config.env);
  if (config.tlsKeyPath) assertProdCertAllowed(config.tlsKeyPath, config.env);

  const tls = Boolean(config.tlsCertPath && config.tlsKeyPath);

  const app = createApiApp({ db: config.db, kek: config.kek });
  app.use("*", corsOnce(config.webOrigin));
  app.use("*", auditLogger(config.logger));

  const server = serve(
    tls
      ? {
          fetch: app.fetch,
          port: config.port,
          hostname: "0.0.0.0",
          createServer: createHttpsServer,
          serverOptions: {
            cert: readFileSync(resolve(config.tlsCertPath!)),
            key: readFileSync(resolve(config.tlsKeyPath!)),
            minVersion: "TLSv1.2",
            maxVersion: "TLSv1.3",
          } as HttpsServerOptions,
        }
      : {
          fetch: app.fetch,
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

/** `start()` used by `pnpm start`; wires env config, DB + KEK, and the server. */
export function start(): Started {
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  const { url } = resolveDatabaseConfig(env);
  const db = createDb({ url });
  const kek = parseKekFromEnv(env);

  const started = buildServer({
    port,
    env: env.NODE_ENV ?? "development",
    db,
    kek,
    webOrigin: env.WEB_ORIGIN,
    tlsCertPath: env.TLS_CERT_PATH,
    tlsKeyPath: env.TLS_KEY_PATH,
    logger: (line) => console.log(line),
  });

  console.log(`[llm-quota] API listening at ${started.address()}`);
  return started;
}
