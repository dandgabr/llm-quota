import { describe, expect, it } from "vitest";
import type { HttpClient } from "@llm-quota/shared";
import { ApiClient, resolveApiBaseUrl } from "../src/lib/api";

describe("ApiClient", () => {
  it("reads quotas with Authorization header", async () => {
    const http: HttpClient = {
      get: async (url) => {
        expect(url).toContain("/v1/quotas");
        return { status: 200, ok: true, json: async () => ({ data: [{ id: "q1", kind: "credits", usedPercent: 25 }] }), text: async () => "" };
      },
      post: async () => ({ status: 201, ok: true, json: async () => ({}), text: async () => "" }),
    };
    const api = new ApiClient("tok", { http, baseUrl: "http://x" });
    const quotas = await api.listQuotas();
    expect(quotas).toHaveLength(1);
    expect(quotas[0]?.kind).toBe("credits");
  });

  it("reads history via the GET alias", async () => {
    const http: HttpClient = {
      get: async (url) => {
        expect(url).toContain("/v1/history");
        return { status: 200, ok: true, json: async () => ({ data: [{ windowKey: "d1", spentAmount: 10, currency: "USD" }] }), text: async () => "" };
      },
      post: async () => ({ status: 201, ok: true, json: async () => ({}), text: async () => "" }),
    };
    const api = new ApiClient("tok", { http, baseUrl: "http://x" });
    const h = await api.readHistory({ from: "2026-01-01", to: "2026-01-02" });
    expect(h[0]?.spentAmount).toBe(10);
  });

  it("creates a connection via POST with the secret in the body", async () => {
    let posted = false;
    const http: HttpClient = {
      get: async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => "" }),
      post: async (url, body, headers) => {
        posted = true;
        expect(url).toContain("/v1/connections");
        expect(String(body)).toContain("hunter2");
        expect(headers?.["Authorization"]).toBe("Bearer tok");
        return { status: 201, ok: true, json: async () => ({ id: "c1", label: "x" }), text: async () => "" };
      },
    };
    const api = new ApiClient("tok", { http, baseUrl: "http://x" });
    await api.createConnection({ providerId: "p", label: "x", secret: "hunter2" });
    expect(posted).toBe(true);
  });
});

describe("resolveApiBaseUrl", () => {
  it("uses VITE_API_URL when set", () => {
    expect(resolveApiBaseUrl({ VITE_API_URL: "http://api/" })).toBe("http://api/");
  });

  it("defaults to localhost:3000", () => {
    expect(resolveApiBaseUrl({})).toBe("http://localhost:3000");
  });
});
