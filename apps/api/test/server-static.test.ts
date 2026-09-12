import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit, redactPath, spaStatic } from "../src/server.js";

describe("spaStatic", () => {
  let dist: string;
  let outside: string;

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), "llm-dist-"));
    outside = await mkdtemp(join(tmpdir(), "llm-out-"));
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<!doctype html><title>spa</title>");
    await writeFile(join(dist, "assets", "app.abc123.js"), "console.log('ok')");
    await writeFile(join(dist, "app.js.map"), "{}");
    await writeFile(join(dist, ".env"), "SECRET=1");
    await writeFile(join(outside, "secret.txt"), "top-secret");
    await symlink(join(outside, "secret.txt"), join(dist, "link.txt"));
  });

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function appWith(distPath: string | undefined) {
    const app = new Hono();
    app.use("*", spaStatic(distPath));
    app.get("/v1/known", (c) => c.json({ ok: true }));
    app.get("/api-only", (c) => c.json({ api: true }));
    return app;
  }

  it("serves a real asset with immutable cache", async () => {
    const app = appWith(dist);
    const res = await app.request("/assets/app.abc123.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("console.log");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("falls back to index.html for unknown non-API routes", async () => {
    const app = appWith(dist);
    const res = await app.request("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>spa</title>");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never serves dotfiles or source maps", async () => {
    const app = appWith(dist);
    expect((await app.request("/.env")).status).not.toBe(200);
    expect((await app.request("/app.js.map")).status).not.toBe(200);
  });

  it("does not follow symlinks outside the dist root", async () => {
    const app = appWith(dist);
    const res = await app.request("/link.txt");
    // Falls back to index.html rather than leaking the outside file.
    const text = await res.text();
    expect(text).not.toContain("top-secret");
  });

  it("leaves /v1|/auth|/health to the API (no html fallback)", async () => {
    const app = new Hono();
    app.use("*", spaStatic(dist));
    app.get("/v1/known", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/unknown");
    // The API app would 404; the SPA must NOT hijack it with index.html.
    expect(res.status).toBe(404);
  });
});

describe("redactPath", () => {
  it("redacts an invite token query value but keeps ids", () => {
    expect(redactPath("/invite?token=abcdefghijklmnop")).toBe("/invite?token=[redacted]");
    expect(redactPath("/v1/admin/invites/123e4567-e89b-12d3")).toBe("/v1/admin/invites/123e4567-e89b-12d3");
  });
});

describe("bodyLimit", () => {
  it("rejects an oversized body with 413", async () => {
    const app = new Hono();
    app.use("*", bodyLimit(10));
    app.post("/x", (c) => c.text("ok"));
    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-length": "999" },
      body: "0123456789",
    });
    expect(res.status).toBe(413);
  });
});
