import { describe, expect, it } from "vitest";
import { summarizeQuota } from "@llm-quota/core";
import type { HttpClient } from "@llm-quota/providers";
import { openRouterConnector, parseOpenRouterQuota } from "../src/index.js";

/** In-memory HttpClient stub returning a canned payload. */
const stubHttp = (body: unknown): HttpClient => ({
  async get() {
    return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  },
});

describe("openrouter: parseOpenRouterQuota", () => {
  it("maps account credits (shape 2.1) with currency", () => {
    const q = parseOpenRouterQuota({ data: { credits: 80, currency: "USD" } });
    expect(q).toEqual({ kind: "credits", currency: "USD", total: 80 });
  });

  it("maps top-level total_credits fallback", () => {
    const q = parseOpenRouterQuota({ total_credits: 99 });
    expect(q).toEqual({ kind: "credits", currency: "USD", total: 99 });
  });

  it("maps usage_ratio into a percent shape", () => {
    const q = parseOpenRouterQuota({ usage_ratio: 0.25 });
    expect(q).toEqual({ kind: "percent", usedPercent: 25, remainingPercent: 75 });
  });

  it("returns an empty percent snapshot when nothing is present", () => {
    const q = parseOpenRouterQuota({});
    expect(q).toEqual({ kind: "percent", usedPercent: 0, remainingPercent: 100 });
  });
});

describe("openrouter: connector -> core wire normalization", () => {
  it("normalizes a credits snapshot into a QuotaSummary via summarizeQuota", async () => {
    const snapshot = await openRouterConnector.fetchQuota({
      connectionId: "c2",
      connectionType: "api",
      apiKey: "test-key",
      http: stubHttp({ data: { credits: 40, currency: "USD" } }),
    });
    const summary = summarizeQuota(snapshot);
    expect(summary.kind).toBe("credits");
    expect(summary.usedPercent).toBeGreaterThanOrEqual(0);
    expect(summary.remainingPercent).toBeGreaterThanOrEqual(0);
  });
});
