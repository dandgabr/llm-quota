import { describe, expect, it } from "vitest";
import { summarizeQuota } from "@llm-quota/core";
import type { HttpClient } from "@llm-quota/providers";
import {
  ollamaClaudeConnector,
  parseOllamaClaudeQuota,
  parseOllamaClaudeLabel,
} from "../src/index.js";

/** In-memory HttpClient stub returning a canned payload. */
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
    return {
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
      header: () => null,
    };
  },
  async put() {
    return {
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
      header: () => null,
    };
  },
  async patch() {
    return {
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
      header: () => null,
    };
  },
  async delete() {
    return {
      status: 200,
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
      header: () => null,
    };
  },
});

describe("ollama-claude: parseOllamaClaudeQuota", () => {
  it("maps credit-based responses (shape 2.1 account total)", () => {
    const q = parseOllamaClaudeQuota({
      quota: { currency: "USD", total_credit: 120.5 },
    });
    expect(q).toEqual({ kind: "credits", currency: "USD", total: 120.5 });
  });

  it("maps capped-quota responses (shape 2.2 used/limit)", () => {
    const q = parseOllamaClaudeQuota({
      quota: { currency: "EUR", used_credit: 10, limit_credit: 50 },
    });
    expect(q).toEqual({
      kind: "credits",
      currency: "EUR",
      used: 10,
      limit: 50,
      resetsAt: undefined,
    });
  });

  it("maps percent usage and computes remaining", () => {
    const q = parseOllamaClaudeQuota({ quota: { used_percent: 30, reset_at: "2026-10-01T00:00:00Z" } });
    expect(q).toEqual({
      kind: "percent",
      usedPercent: 30,
      remainingPercent: 70,
      resetsAt: "2026-10-01T00:00:00Z",
    });
  });

  it("clamps over-100 percent usage to 0 remaining", () => {
    const q = parseOllamaClaudeQuota({ quota: { used_percent: 150 } });
    expect(q.kind).toBe("percent");
    if (q.kind === "percent") {
      expect(q.remainingPercent).toBe(0);
    }
  });

  it("returns an empty percent snapshot when no quota block is present", () => {
    const q = parseOllamaClaudeQuota({});
    expect(q).toEqual({ kind: "percent", usedPercent: 0, remainingPercent: 100 });
  });
});

describe("ollama-claude: parseOllamaClaudeLabel", () => {
  it("returns display_name when present", () => {
    expect(parseOllamaClaudeLabel({ display_name: "Team Plan" })).toBe("Team Plan");
  });

  it("returns null when absent or empty", () => {
    expect(parseOllamaClaudeLabel({})).toBeNull();
    expect(parseOllamaClaudeLabel({ display_name: "" })).toBeNull();
  });
});

describe("ollama-claude: connector -> core wire normalization", () => {
  it("normalizes a credit snapshot into a QuotaSummary via summarizeQuota", async () => {
    const snapshot = await ollamaClaudeConnector.fetchQuota({
      connectionId: "c1",
      connectionType: "api",
      apiKey: "test-key",
      http: stubHttp({ quota: { currency: "USD", used_credit: 25, limit_credit: 100 } }),
    });
    const summary = summarizeQuota(snapshot);
    expect(summary.kind).toBe("credits");
    expect(summary.usedPercent).toBe(25);
    expect(summary.remainingPercent).toBe(75);
  });
});
