import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { createFetchHttpClient } from "@llm-quota/shared";

/** Minimal DB stub for server tests (no live Postgres). */
const makeDb = () => {
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: () => ({}) }),
  };
  return {
    db: db as never,
    pool: { end: async () => undefined } as never,
    close: async () => undefined,
  };
};

const KEK = Buffer.alloc(32, 1);

/** Wait until the server is listening, then return its resolved port. */
function listenAndUrl(s: ReturnType<typeof buildServer>, port = 0): Promise<string> {
  return new Promise((resolveListen) => {
    s.server.once("listening", () => {
      const a = s.server.address();
      const p = typeof a === "object" && a ? a.port : port;
      resolveListen(`http://127.0.0.1:${p}`);
    });
  });
}

describe("buildServer", () => {
  it("serves an HTTP listener and responds on /v1/quotas (401 without auth)", async () => {
    const s = buildServer({
      port: 0,
      env: "test",
      db: makeDb() as never,
      kek: KEK,
      webOrigin: "http://localhost:5173",
    });
    const base = await listenAndUrl(s);
    const http = createFetchHttpClient();
    const res = await http.get(`${base}/v1/quotas`);
    expect(res.status).toBe(401); // no bearer => unauthorized
    await s.close();
  }, 10_000);
});
