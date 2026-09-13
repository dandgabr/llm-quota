import { describe, expect, it } from "vitest";
import { summarizeQuota } from "@llm-quota/core";
import type { HttpClient } from "@llm-quota/providers";
import {
  antigravityConnector,
  parseAntigravityQuota,
  parseAntigravityCredentials,
  getValidAccessToken,
} from "../src/index.js";

const stubHttp = (tokenResponse: unknown, quotaResponse: unknown): HttpClient => ({
  async get(url: string) {
    return {
      status: 200,
      ok: true,
      json: async () => quotaResponse,
      text: async () => JSON.stringify(quotaResponse),
      header: () => null,
    };
  },
  async post(url: string) {
    if (url.includes("oauth2.googleapis.com")) {
      return {
        status: 200,
        ok: true,
        json: async () => tokenResponse,
        text: async () => JSON.stringify(tokenResponse),
        header: () => null,
      };
    }
    // Cloud Code endpoints
    return {
      status: 200,
      ok: true,
      json: async () => quotaResponse,
      text: async () => JSON.stringify(quotaResponse),
      header: () => null,
    };
  },
  async put() {
    return { status: 200, ok: true, json: async () => ({}), text: async () => "{}", header: () => null };
  },
  async patch() {
    return { status: 200, ok: true, json: async () => ({}), text: async () => "{}", header: () => null };
  },
  async delete() {
    return { status: 200, ok: true, json: async () => ({}), text: async () => "{}", header: () => null };
  },
});

describe("antigravity: parseAntigravityQuota", () => {
  it("parses session and daily quotas", () => {
    const raw = {
      session: {
        used_percent: 25,
        remaining_percent: 75,
        resets_at: "2026-09-13T04:00:00.000Z",
      },
      daily: {
        used_percent: 60,
        remaining_percent: 40,
        resets_at: "2026-09-14T00:00:00.000Z",
      },
    };
    const sessionQuota = parseAntigravityQuota(raw, "session");
    expect(sessionQuota).toEqual({
      kind: "percent",
      usedPercent: 25,
      remainingPercent: 75,
      resetsAt: "2026-09-13T04:00:00.000Z",
    });

    const dailyQuota = parseAntigravityQuota(raw, "daily");
    expect(dailyQuota).toEqual({
      kind: "percent",
      usedPercent: 60,
      remainingPercent: 40,
      resetsAt: "2026-09-14T00:00:00.000Z",
    });
  });

  it("parses models mapping into GEMINI and CLAUDE/GPT model groups", () => {
    const raw = {
      models: {
        "gemini-2.5-pro": {
          quotaInfo: {
            remainingFraction: 0.55,
            resetTime: "2026-09-13T16:00:00.000Z",
          },
        },
        "claude-sonnet-4-6": {
          quotaInfo: {
            remainingFraction: 0.90,
            resetTime: "2026-09-13T17:00:00.000Z",
          },
        },
      },
    };
    const q = parseAntigravityQuota(raw, "session");
    expect(q.kind).toBe("percent");
    expect(q.usedPercent).toBe(45);
    expect(q.remainingPercent).toBe(55);
    expect(q.modelGroups).toHaveLength(2);
    expect(q.modelGroups?.[0]?.name).toBe("GEMINI MODELS");
    expect(q.modelGroups?.[0]?.session?.remainingPercent).toBe(55);
    expect(q.modelGroups?.[1]?.name).toBe("CLAUDE AND GPT MODELS");
    expect(q.modelGroups?.[1]?.session?.remainingPercent).toBe(90);
  });
});

describe("antigravity: token refresh logic", () => {
  it("uses valid cached access_token without refreshing", async () => {
    const http = stubHttp({}, {});
    const creds = {
      accessToken: "existing-valid-token",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const token = await getValidAccessToken(creds, http);
    expect(token).toBe("existing-valid-token");
  });

  it("refreshes expired access_token using refresh_token", async () => {
    let savedNewSecret: string | null = null;
    const http = stubHttp(
      { access_token: "newly-refreshed-token", expires_in: 3600 },
      { session: { used_percent: 10 } }
    );
    const creds = {
      refreshToken: "sample-refresh-token",
      accessToken: "expired-token",
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    };

    const token = await getValidAccessToken(creds, http, async (s) => {
      savedNewSecret = s;
    });

    expect(token).toBe("newly-refreshed-token");
    expect(savedNewSecret).toBeTruthy();
    expect(savedNewSecret).toContain("newly-refreshed-token");
  });
});

describe("antigravity connector end-to-end fetchQuota", () => {
  it("fetches and normalizes quota with OAuth credentials", async () => {
    const http = stubHttp(
      { access_token: "refreshed-token", expires_in: 3600 },
      { session: { used_percent: 15, remaining_percent: 85 } }
    );
    const snapshot = await antigravityConnector.fetchQuota({
      connectionId: "c-antigravity",
      connectionType: "oauth",
      apiKey: JSON.stringify({ refresh_token: "my-rt" }),
      http,
    });
    const summary = summarizeQuota(snapshot);
    expect(summary.kind).toBe("percent");
    expect(summary.usedPercent).toBe(15);
    expect(summary.remainingPercent).toBe(85);
  });
});
