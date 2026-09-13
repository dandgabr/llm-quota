import type {
  ProviderConnector,
  ProviderContext,
  QuotaSnapshot,
} from "@llm-quota/providers";
import { createFetchHttpClient } from "@llm-quota/providers";

/**
 * OpenRouter (API) connector (v1, Phase 3). Second concrete connector that
 * validates the `ProviderConnector` + `HttpClient` pattern with a different
 * provider payload. Reads account/quota data via the OpenRouter API and returns
 * a raw `QuotaSnapshot` for `core` to normalize.
 */

/** Default base URL for the OpenRouter API (envar overridable). */
const DEFAULT_BASE_URL = "https://openrouter.ai/api";

/** Response shape from the OpenRouter account/credits endpoint (subset). */
interface OpenRouterCreditsResponse {
  data?: {
    /** Monetary credits remaining in the account (USD). */
    credits?: number;
    total_credits?: number;
    total_usage?: number;
    usage?: number;
    currency?: string;
  };
  total_credits?: number;
  credits?: number;
  total_usage?: number;
  usage?: number;
  usage_ratio?: number;
}

/** Map a raw OpenRouter payload to a normalized `QuotaSnapshot`. */
export function parseOpenRouterQuota(body: unknown): QuotaSnapshot {
  const raw = (body ?? {}) as OpenRouterCreditsResponse;

  // Credit-based: account credits remaining or total credits (shape 2.1).
  const credits = raw.data?.total_credits ?? raw.data?.credits ?? raw.total_credits ?? raw.credits;
  const used = raw.data?.total_usage ?? raw.data?.usage ?? raw.total_usage ?? raw.usage;
  if (typeof credits === "number") {
    return {
      kind: "credits",
      currency: raw.data?.currency ?? "USD",
      total: credits,
      ...(typeof used === "number" ? { used } : {}),
    };
  }

  // Usage-ratio fallback (0..1): express as percentage shape.
  if (typeof raw.usage_ratio === "number") {
    const usedPercent = Math.round(raw.usage_ratio * 100);
    return {
      kind: "percent",
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
    };
  }

  return { kind: "percent", usedPercent: 0, remainingPercent: 100 };
}

const base = {
  id: "openrouter/api",
  name: "OpenRouter",
  connectionType: "api" as const,
  quotaType: "credits" as const,
  supportedWindows: ["lifetime"] as const,
};

export const openRouterConnector: ProviderConnector = {
  ...base,

  async fetchQuota(context: ProviderContext): Promise<QuotaSnapshot> {
    const { apiKey, baseUrl = DEFAULT_BASE_URL } = context;
    const http = context.http ?? createFetchHttpClient();
    const url = `${baseUrl}/v1/credits`;
    const res = await http.get(url, {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter quota request failed (${res.status})`);
    }
    return parseOpenRouterQuota(await res.json());
  },

  async discoverLabel(): Promise<string | null> {
    // Best-effort: OpenRouter does not expose a display name via the credits
    // endpoint; keep it null until a suitable account endpoint is wired.
    return null;
  },
};
