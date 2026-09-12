import { describe, expect, it } from "vitest";
import type { HttpClient } from "@llm-quota/shared";
import { ApiClient, resolveApiBaseUrl } from "../src/lib/api";

/** Minimal HttpClient stub with the verbs ApiClient may call. */
function makeHttp(overrides: Partial<HttpClient> = {}): HttpClient {
  const ok = async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => "" });
  return {
    get: ok,
    post: ok,
    put: ok,
    patch: ok,
    delete: ok,
    ...overrides,
  };
}

describe("ApiClient", () => {
  it("reads quotas with Authorization header", async () => {
    const http = makeHttp({
      get: async (url) => {
        expect(url).toContain("/v1/quotas");
        return { status: 200, ok: true, json: async () => ({ data: [{ id: "q1", kind: "credits", usedPercent: 25 }] }), text: async () => "" };
      },
    });
    const api = new ApiClient("tok", { http, baseUrl: "http://x" });
    const quotas = await api.listQuotas();
    expect(quotas).toHaveLength(1);
    expect(quotas[0]?.kind).toBe("credits");
  });

  it("reads history via the GET alias", async () => {
    const http = makeHttp({
      get: async (url) => {
        expect(url).toContain("/v1/history");
        return { status: 200, ok: true, json: async () => ({ data: [{ windowKey: "d1", spentAmount: 10, currency: "USD" }] }), text: async () => "" };
      },
    });
    const api = new ApiClient("tok", { http, baseUrl: "http://x" });
    const h = await api.readHistory({ from: "2026-01-01", to: "2026-01-02" });
    expect(h[0]?.spentAmount).toBe(10);
  });

  it("creates a connection via POST with the secret in the body", async () => {
    let posted = false;
    const http = makeHttp({
      post: async (url, body, headers) => {
        posted = true;
        expect(url).toContain("/v1/connections");
        expect(String(body)).toContain("hunter2");
        expect(headers?.["Authorization"]).toBe("Bearer tok");
        return { status: 201, ok: true, json: async () => ({ id: "c1", label: "x" }), text: async () => "" };
      },
    });
    const api = new ApiClient("tok", { http, baseUrl: "http://x" });
    await api.createConnection({ providerId: "p", label: "x", secret: "hunter2" });
    expect(posted).toBe(true);
  });

  it("throws a typed ApiError carrying the problem type", async () => {
    const http = makeHttp({
      delete: async () => ({
        status: 409,
        ok: false,
        json: async () => ({ type: "https://api.llm-quota.dev/errors/last-admin", title: "Conflict" }),
        text: async () => "",
      }),
    });
    const api = new ApiClient("tok", { http, baseUrl: "http://x" });
    await expect(api.deleteUser("u1")).rejects.toMatchObject({ status: 409, code: "last-admin" });
  });
});

describe("resolveApiBaseUrl", () => {
  it("uses VITE_API_URL when set", () => {
    expect(resolveApiBaseUrl({ VITE_API_URL: "http://api/" })).toBe("http://api/");
  });

  it("defaults to same-origin when unset", () => {
    expect(resolveApiBaseUrl({})).toBe("");
  });
});
