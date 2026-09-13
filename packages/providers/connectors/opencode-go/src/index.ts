import type {
  ProviderConnector,
  ProviderContext,
  QuotaSnapshot,
} from "@llm-quota/providers";
import { createFetchHttpClient } from "@llm-quota/providers";

/**
 * OpenCode Go (API) connector.
 * Reads balance, token limits, and quota information from OpenCode Go endpoints.
 */

const DEFAULT_BASE_URL = "https://opencode.ai";

interface OpenCodeQuotaWindowDetails {
  credits?: number;
  total_credits?: number;
  used_credits?: number;
  remaining_credits?: number;
  total?: number;
  used?: number;
  remaining?: number;
  limit?: number;
  currency?: string;
  usage_percent?: number;
  used_percent?: number;
  remaining_percent?: number;
  percent?: number;
  usage?: number;
  reset_at?: string;
  resets_at?: string;
  reset_time?: string;
}

interface OpenCodeQuotaResponse {
  credits?: number;
  total_credits?: number;
  used_credits?: number;
  remaining_credits?: number;
  currency?: string;
  usage_percent?: number;
  used_percent?: number;
  remaining_percent?: number;
  reset_at?: string;
  resets_at?: string;
  session?: OpenCodeQuotaWindowDetails;
  weekly?: OpenCodeQuotaWindowDetails;
  monthly?: OpenCodeQuotaWindowDetails;
  limits?: {
    session?: OpenCodeQuotaWindowDetails;
    weekly?: OpenCodeQuotaWindowDetails;
    monthly?: OpenCodeQuotaWindowDetails;
  };
  quotas?: {
    session?: OpenCodeQuotaWindowDetails;
    weekly?: OpenCodeQuotaWindowDetails;
    monthly?: OpenCodeQuotaWindowDetails;
  };
  data?: {
    credits?: number;
    used?: number;
    total?: number;
    currency?: string;
    reset_at?: string;
    resets_at?: string;
    session?: OpenCodeQuotaWindowDetails;
    weekly?: OpenCodeQuotaWindowDetails;
    monthly?: OpenCodeQuotaWindowDetails;
    limits?: {
      session?: OpenCodeQuotaWindowDetails;
      weekly?: OpenCodeQuotaWindowDetails;
      monthly?: OpenCodeQuotaWindowDetails;
    };
    quotas?: {
      session?: OpenCodeQuotaWindowDetails;
      weekly?: OpenCodeQuotaWindowDetails;
      monthly?: OpenCodeQuotaWindowDetails;
    };
  };
  user?: {
    name?: string;
    email?: string;
  };
}

export function parseOpenCodeQuota(body: unknown, targetWindow = "session"): QuotaSnapshot {
  const raw = (body ?? {}) as OpenCodeQuotaResponse;
  const data = raw.data ?? {};

  // 1. Look for window-specific block: session, weekly, or monthly
  let winBlock: OpenCodeQuotaWindowDetails | undefined;
  if (targetWindow === "weekly") {
    winBlock = raw.weekly ?? raw.limits?.weekly ?? raw.quotas?.weekly ?? data.weekly ?? data.limits?.weekly ?? data.quotas?.weekly;
  } else if (targetWindow === "monthly") {
    winBlock = raw.monthly ?? raw.limits?.monthly ?? raw.quotas?.monthly ?? data.monthly ?? data.limits?.monthly ?? data.quotas?.monthly;
  } else {
    // "session" or 5-hour limit
    winBlock =
      raw.session ??
      (raw as Record<string, unknown>).five_hours as OpenCodeQuotaWindowDetails ??
      (raw as Record<string, unknown>).five_hour as OpenCodeQuotaWindowDetails ??
      raw.limits?.session ??
      raw.quotas?.session ??
      data.session ??
      data.limits?.session ??
      data.quotas?.session;
  }

  if (winBlock) {
    const total = winBlock.total_credits ?? winBlock.credits ?? winBlock.total ?? winBlock.limit;
    const used = winBlock.used_credits ?? winBlock.used;
    const currency = winBlock.currency ?? raw.currency ?? data.currency ?? "USD";
    const resetAt = winBlock.resets_at ?? winBlock.reset_at ?? winBlock.reset_time;

    if (typeof total === "number") {
      return {
        kind: "credits",
        currency,
        total,
        ...(typeof used === "number" ? { used } : {}),
        ...(resetAt ? { resetsAt: resetAt } : {}),
      };
    }

    const rawPercent = winBlock.used_percent ?? winBlock.usage_percent ?? winBlock.percent ?? winBlock.usage;
    if (typeof rawPercent === "number") {
      const usedPercent = Math.min(100, Math.max(0, rawPercent));
      const remainingPercent =
        typeof winBlock.remaining_percent === "number"
          ? winBlock.remaining_percent
          : Math.max(0, 100 - usedPercent);
      return {
        kind: "percent",
        usedPercent,
        remainingPercent,
        ...(resetAt ? { resetsAt: resetAt } : {}),
      };
    }
  }

  // 2. Fallback to top-level fields (common for single-quota payloads)
  const total = raw.total_credits ?? raw.credits ?? data.total ?? data.credits;
  const used = raw.used_credits ?? data.used;
  const currency = raw.currency ?? data.currency ?? "USD";
  const resetAt = raw.resets_at ?? raw.reset_at ?? data.reset_at ?? data.resets_at;

  if (typeof total === "number") {
    return {
      kind: "credits",
      currency,
      total,
      ...(typeof used === "number" ? { used } : {}),
      ...(resetAt ? { resetsAt: resetAt } : {}),
    };
  }

  const topPercent = raw.used_percent ?? raw.usage_percent;
  if (typeof topPercent === "number") {
    const usedPercent = Math.min(100, Math.max(0, topPercent));
    return {
      kind: "percent",
      usedPercent,
      remainingPercent: typeof raw.remaining_percent === "number" ? raw.remaining_percent : Math.max(0, 100 - usedPercent),
      ...(resetAt ? { resetsAt: resetAt } : {}),
    };
  }

  return { kind: "percent", usedPercent: 0, remainingPercent: 100, ...(resetAt ? { resetsAt: resetAt } : {}) };
}

export function parseOpenCodeLabel(body: unknown): string | null {
  const raw = (body ?? {}) as OpenCodeQuotaResponse;
  return raw.user?.email ?? raw.user?.name ?? null;
}

const base = {
  id: "opencode-go/api",
  name: "OpenCode Go",
  connectionType: "api" as const,
  quotaType: "sliding_window" as const,
  supportedWindows: ["session", "weekly", "monthly"] as const,
};

export const opencodeGoConnector: ProviderConnector = {
  ...base,

  async fetchQuota(context: ProviderContext): Promise<QuotaSnapshot> {
    const { apiKey, baseUrl = DEFAULT_BASE_URL, window: targetWindow } = context;
    const http = context.http ?? createFetchHttpClient();

    // Try dedicated quota endpoint if available
    const quotaUrl = `${baseUrl}/zen/go/v1/quota`;
    const res = await http.get(quotaUrl, {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });

    if (res.ok) {
      try {
        const data = await res.json();
        return parseOpenCodeQuota(data, targetWindow);
      } catch {
        // Fall back to ping validation
      }
    }

    // OpenCode Go validates API keys via the OpenAI-compatible completions endpoint:
    // POST https://opencode.ai/zen/go/v1/chat/completions
    const completionsUrl = `${baseUrl}/zen/go/v1/chat/completions`;
    const pingRes = await http.post(
      completionsUrl,
      JSON.stringify({
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    );

    if (pingRes.status === 401 || pingRes.status === 403) {
      throw new Error("Invalid OpenCode Go API key");
    }

    // If endpoint responds ok or any non-auth response (e.g. rate limit / success),
    // the key is authenticated.
    return {
      kind: "percent",
      usedPercent: 0,
      remainingPercent: 100,
    };
  },

  async discoverLabel(context: ProviderContext): Promise<string | null> {
    const { apiKey, baseUrl = DEFAULT_BASE_URL } = context;
    const http = context.http ?? createFetchHttpClient();
    const url = `${baseUrl}/zen/go/v1/user`;
    const res = await http.get(url, {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });
    if (!res.ok) return null;
    try {
      return parseOpenCodeLabel(await res.json());
    } catch {
      return null;
    }
  },
};
