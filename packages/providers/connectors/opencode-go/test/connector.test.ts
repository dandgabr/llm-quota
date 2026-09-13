import { describe, expect, it } from "vitest";
import { summarizeQuota } from "@llm-quota/core";
import type { HttpClient } from "@llm-quota/providers";
import { opencodeGoConnector, parseOpenCodeQuota, parseOpenCodeLabel } from "../src/index.js";

const stubHttp = (body: unknown): HttpClient => ({
  async get() {
    return {
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
      header: () => null,
    };
  },
  async post() {
    return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body), header: () => null };
  },
  async put() {
    return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body), header: () => null };
  },
  async patch() {
    return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body), header: () => null };
  },
  async delete() {
    return { status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body), header: () => null };
  },
});

describe("opencode-go: parseOpenCodeQuota", () => {
  it("maps credit-based quotas with reset date", () => {
    const q = parseOpenCodeQuota({
      credits: 120,
      used_credits: 20,
      currency: "USD",
      resets_at: "2026-10-01T00:00:00.000Z",
    });
    expect(q).toEqual({
      kind: "credits",
      currency: "USD",
      total: 120,
      used: 20,
      resetsAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("maps usage percentage", () => {
    const q = parseOpenCodeQuota({
      usage_percent: 35,
      remaining_percent: 65,
    });
    expect(q).toEqual({
      kind: "percent",
      usedPercent: 35,
      remainingPercent: 65,
    });
  });

  it("extracts window-specific quota for session, weekly, and monthly", () => {
    const payload = {
      limits: {
        session: { used_percent: 10, remaining_percent: 90, resets_at: "2026-09-13T16:00:00.000Z" },
        weekly: { used_percent: 45, remaining_percent: 55, resets_at: "2026-09-20T00:00:00.000Z" },
        monthly: { used_percent: 80, remaining_percent: 20, resets_at: "2026-10-01T00:00:00.000Z" },
      },
    };

    const sessionQ = parseOpenCodeQuota(payload, "session");
    expect(sessionQ).toEqual({
      kind: "percent",
      usedPercent: 10,
      remainingPercent: 90,
      resetsAt: "2026-09-13T16:00:00.000Z",
    });

    const weeklyQ = parseOpenCodeQuota(payload, "weekly");
    expect(weeklyQ).toEqual({
      kind: "percent",
      usedPercent: 45,
      remainingPercent: 55,
      resetsAt: "2026-09-20T00:00:00.000Z",
    });

    const monthlyQ = parseOpenCodeQuota(payload, "monthly");
    expect(monthlyQ).toEqual({
      kind: "percent",
      usedPercent: 80,
      remainingPercent: 20,
      resetsAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("extracts label", () => {
    expect(parseOpenCodeLabel({ user: { email: "dev@opencode.ai" } })).toBe("dev@opencode.ai");
  });
});

describe("opencode-go connector", () => {
  it("fetches quota and normalizes snapshot", async () => {
    const snapshot = await opencodeGoConnector.fetchQuota({
      connectionId: "c-opencode",
      connectionType: "api",
      apiKey: "test-token",
      http: stubHttp({ total_credits: 50, used_credits: 5 }),
    });
    expect(snapshot.kind).toBe("credits");
    if (snapshot.kind === "credits") {
      expect(snapshot.total).toBe(50);
      expect(snapshot.used).toBe(5);
    }
    const summary = summarizeQuota(snapshot);
    expect(summary.kind).toBe("credits");
    expect(summary.usedPercent).toBeGreaterThanOrEqual(0);
  });
});
