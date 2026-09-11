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
const DEFAULT_BASE_URL = "https://api.ollamacloud.com";

/**
 * Response shape from the Ollama Claude quota endpoint (subset we consume).
 */
interface OllamaClaudeQuotaResponse {
  quota?: {
    /** 0..100 used percentage when the plan is usage-percent based. */
    used_percent?: number;
    /** Monetary account credit (USD) when the plan is credit based. */
    total_credit?: number;
    /** Amount used (USD) for a capped-quota plan. */
    used_credit?: number;
    /** Quota limit (USD) for a capped-quota plan. */
    limit_credit?: number;
    currency?: string;
    reset_at?: string;
  };
  display_name?: string;
}

/** Map a raw provider payload to a normalized `QuotaSnapshot`. */
export function parseOllamaClaudeQuota(body: unknown): QuotaSnapshot {
  const { quota } = (body ?? {}) as OllamaClaudeQuotaResponse;
  if (!quota) {
    return { kind: "percent", usedPercent: 0, remainingPercent: 100 };
  }

  // Credit-based plans carry a currency (or a credit amount).
  if (quota.currency || quota.total_credit != null || quota.used_credit != null) {
    return {
      kind: "credits",
      currency: quota.currency ?? "USD",
      total: quota.total_credit,
      used: quota.used_credit,
      limit: quota.limit_credit,
      resetsAt: quota.reset_at,
    };
  }

  const usedPercent = typeof quota.used_percent === "number" ? quota.used_percent : 0;
  return {
    kind: "percent",
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAt: quota.reset_at,
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
};

export const ollamaClaudeConnector: ProviderConnector = {
  ...base,

  async fetchQuota(context: ProviderContext): Promise<QuotaSnapshot> {
    const { apiKey, baseUrl = DEFAULT_BASE_URL } = context;
    const http = context.http ?? createFetchHttpClient();
    const url = `${baseUrl}/v1/quota`;
    const res = await http.get(url, {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });
    if (!res.ok) {
      throw new Error(`Ollama Claude quota request failed (${res.status})`);
    }
    return parseOllamaClaudeQuota(await res.json());
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
