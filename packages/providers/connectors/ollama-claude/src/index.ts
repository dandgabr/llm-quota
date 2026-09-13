import type {
  ProviderConnector,
  ProviderContext,
  QuotaSnapshot,
} from "@llm-quota/providers";
import { createFetchHttpClient } from "@llm-quota/providers";

/**
 * Ollama Claude connector (v1, Phase 3 functional). Reads the account quota via
 * the provider's JSON API and returns a raw `QuotaSnapshot` for `core` to
 * normalize. The endpoint/header shape follows the documented Ollama Claude
 * quota API; the response parser is unit-tested against fixtures.
 */

/** Default base URL for the Ollama Claude quota endpoint (envar overridable). */
const DEFAULT_BASE_URL = "https://ollama.com";

interface QuotaWindowDetails {
  used_percent?: number;
  remaining_percent?: number;
  usage?: number;
  used?: number;
  limit?: number;
  total?: number;
  resets_at?: string;
  reset_at?: string;
}

/**
 * Response shape from the Ollama Claude quota endpoint (subset we consume).
 * Supports both unified `quota`, cloud `limits.session`/`limits.weekly`, and windowed fields.
 */
interface OllamaClaudeQuotaResponse {
  quota?: {
    /** 0..100 used percentage when the plan is usage-percent based. */
    used_percent?: number;
    usage?: number;
    /** Monetary account credit (USD) when the plan is credit based. */
    total_credit?: number;
    /** Amount used (USD) for a capped-quota plan. */
    used_credit?: number;
    /** Quota limit (USD) for a capped-quota plan. */
    limit_credit?: number;
    currency?: string;
    reset_at?: string;
    resets_at?: string;
  };
  limits?: {
    session?: QuotaWindowDetails;
    weekly?: QuotaWindowDetails;
    monthly?: QuotaWindowDetails;
  };
  session?: QuotaWindowDetails;
  weekly?: QuotaWindowDetails;
  monthly?: QuotaWindowDetails;
  display_name?: string;
}

/** Map a raw provider payload to a normalized `QuotaSnapshot`. */
export function parseOllamaClaudeQuota(body: unknown, targetWindow?: string): QuotaSnapshot {
  const raw = (body ?? {}) as OllamaClaudeQuotaResponse;

  let windowBlock: QuotaWindowDetails | undefined;
  if (targetWindow === "session") {
    windowBlock = raw.limits?.session ?? raw.session;
  } else if (targetWindow === "weekly") {
    windowBlock = raw.limits?.weekly ?? raw.weekly;
  } else if (targetWindow === "monthly") {
    windowBlock = raw.limits?.monthly ?? raw.monthly;
  }

  const quota = windowBlock ?? raw.quota ?? raw.limits?.weekly ?? raw.limits?.session ?? raw.session ?? raw.weekly ?? raw.monthly;
  if (!quota) {
    return { kind: "percent", usedPercent: 0, remainingPercent: 100 };
  }

  const resetAt =
    ("reset_at" in quota ? quota.reset_at : undefined) ??
    ("resets_at" in quota ? quota.resets_at : undefined);

  // Credit-based plans carry a currency (or a credit amount).
  const totalCredit = "total_credit" in quota ? quota.total_credit : "total" in quota ? quota.total : undefined;
  const usedCredit = "used_credit" in quota ? quota.used_credit : "used" in quota ? quota.used : undefined;
  const limitCredit = "limit_credit" in quota ? quota.limit_credit : "limit" in quota ? quota.limit : undefined;
  const currency = "currency" in quota && typeof quota.currency === "string" ? quota.currency : undefined;

  if (currency || totalCredit != null || usedCredit != null) {
    return {
      kind: "credits",
      currency: currency ?? "USD",
      total: totalCredit,
      used: usedCredit,
      limit: limitCredit,
      resetsAt: resetAt,
    };
  }

  const rawPercent =
    typeof quota.used_percent === "number"
      ? quota.used_percent
      : typeof quota.usage === "number"
        ? quota.usage
        : 0;

  const usedPercent = rawPercent;
  const remainingPercent =
    "remaining_percent" in quota && typeof quota.remaining_percent === "number"
      ? quota.remaining_percent
      : Math.max(0, 100 - usedPercent);

  return {
    kind: "percent",
    usedPercent,
    remainingPercent,
    resetsAt: resetAt,
  };
}

/** Best-effort account label from the provider payload. */
export function parseOllamaClaudeLabel(body: unknown): string | null {
  const { display_name } = (body ?? {}) as OllamaClaudeQuotaResponse;
  return display_name && display_name.length > 0 ? display_name : null;
}

const base = {
  id: "ollama-claude/api",
  name: "Ollama Claude",
  connectionType: "api" as const,
  quotaType: "sliding_window" as const,
  supportedWindows: ["session", "weekly"] as const,
};

export const ollamaClaudeConnector: ProviderConnector = {
  ...base,

  async fetchQuota(context: ProviderContext): Promise<QuotaSnapshot> {
    const { apiKey, baseUrl = DEFAULT_BASE_URL } = context;
    const http = context.http ?? createFetchHttpClient();
    // Try https://ollama.com/api/usage first, then fallback to /v1/quota
    const usageUrl = `${baseUrl}/api/usage`;
    let res = await http.get(usageUrl, {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });
    if (!res.ok && res.status === 404) {
      const fallbackUrl = `${baseUrl}/v1/quota`;
      res = await http.get(fallbackUrl, {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      });
    }
    if (!res.ok) {
      throw new Error(`Ollama Claude quota request failed (${res.status})`);
    }
    return parseOllamaClaudeQuota(await res.json(), (context as { window?: string }).window);
  },

  async discoverLabel(context: ProviderContext): Promise<string | null> {
    const { apiKey, baseUrl = DEFAULT_BASE_URL } = context;
    const http = context.http ?? createFetchHttpClient();
    const url = `${baseUrl}/v1/account`;
    const res = await http.get(url, {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });
    if (!res.ok) return null;
    return parseOllamaClaudeLabel(await res.json());
  },
};
