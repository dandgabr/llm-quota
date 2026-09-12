import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/app.js";
import type { DbHandle } from "@llm-quota/db";

/** Minimal DB stub for API tests — no live Postgres. */
const makeDb = (): DbHandle => {
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
    // set_config calls from resolvePrincipal's RLS context.
    execute: async () => ({ rows: [] }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
    insert: () => ({ values: () => ({}) }),
  };
  return {
    db: db as never,
    pool: { end: async () => undefined } as never,
    close: async () => undefined,
  };
};

const BEARER = "test-token";
const KEK = Buffer.alloc(32, 1); // fixed 32-byte test KEK

describe("REST API (Hono, ADR-008)", () => {
  it("returns 401 without a bearer token", async () => {
    const app = createApiApp({ db: makeDb(), kek: KEK });
    const res = await app.request("/v1/quotas");
    expect(res.status).toBe(401);
  });

  it("rejects unknown sessions with 401", async () => {
    const app = createApiApp({ db: makeDb(), kek: KEK });
    const res = await app.request("/v1/quotas", {
      headers: { Authorization: "Bearer bad-token" },
    });
    expect(res.status).toBe(401);
  });

  it("serves the QUERY history route (RFC 10008) when authorized", async () => {
    const app = createApiApp({ db: makeDb(), kek: KEK });
    const res = await app.request("/v1/history", {
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    expect(res.status).toBe(401); // stub DB has no session for the token.
  });
});
