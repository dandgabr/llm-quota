import { Hono } from "hono";
import { describe, expect, it } from "vitest";

/**
 * Minimal smoke test proving Hono (Phase 5 framework) is wired: an app that
 * serves a GET and a QUERY route, so we know the arbitrary-method routing the
 * ADR-008 `QUERY` contract needs actually works before building the real API.
 */

describe("hono app (smoke)", () => {
  it("serves a GET route", async () => {
    const app = new Hono();
    app.get("/ping", (c) => c.json({ ok: true }));
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves a QUERY method route (RFC 10008)", async () => {
    const app = new Hono();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).on("QUERY", "/search", async (c: { req: { json(): Promise<{ q: string }> }; json(o: unknown): Response }) => {
      const body = await c.req.json();
      return c.json({ matched: body.q ?? null });
    });
    const res = await app.request("/search", {
      method: "QUERY",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "history" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matched: "history" });
  });

  it("returns 404 for an unknown route", async () => {
    const app = new Hono();
    app.get("/ping", (c) => c.json({ ok: true }));
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
