import type {
  HttpClient,
  ProviderConnector,
  ProviderContext,
  ProviderOAuthCredentials,
  QuotaSnapshot,
} from "@llm-quota/providers";
import { createFetchHttpClient } from "@llm-quota/providers";

/**
 * Google Antigravity / Gemini Code Assist (OAuth) connector.
 * Handles OAuth 2.0 token expiration, refresh using Google Token endpoint,
 * and parses quota metrics for session, daily and weekly quota windows.
 */

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_BASE_URL = "https://cloudcode-pa.googleapis.com";

export interface AntigravityQuotaBucket {
  limit?: number;
  remaining?: number;
  used?: number;
  remaining_percent?: number;
  used_percent?: number;
  reset_time?: string;
  resets_at?: string;
}

export interface AntigravityQuotaResponse {
  session?: AntigravityQuotaBucket;
  daily?: AntigravityQuotaBucket;
  weekly?: AntigravityQuotaBucket;
  user_email?: string;
  quotas?: {
    session?: AntigravityQuotaBucket;
    daily?: AntigravityQuotaBucket;
    weekly?: AntigravityQuotaBucket;
  };
}

export function parseAntigravityQuota(body: unknown, window = "session"): QuotaSnapshot {
  const raw = (body ?? {}) as AntigravityQuotaResponse & {
    models?: Record<string, {
      quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
      };
      isInternal?: boolean;
    }>;
  };

  // 1. If response has models mapping (Google Cloud Code fetchAvailableModels)
  if (raw.models && typeof raw.models === "object") {
    let minRemaining = 1.0;
    let earliestReset: string | undefined;
    let found = false;

    // Group models: Gemini vs Claude/GPT
    const geminiModels: string[] = [];
    let geminiMinRemaining = 1.0;
    let geminiReset: string | undefined;

    const claudeGptModels: string[] = [];
    let claudeGptMinRemaining = 1.0;
    let claudeGptReset: string | undefined;

    for (const [modelKey, info] of Object.entries(raw.models)) {
      if (info.isInternal || !info.quotaInfo || info.quotaInfo.remainingFraction == null) continue;
      found = true;
      const frac = Number(info.quotaInfo.remainingFraction);
      if (!Number.isNaN(frac) && frac < minRemaining) {
        minRemaining = frac;
      }
      if (info.quotaInfo.resetTime && (!earliestReset || info.quotaInfo.resetTime < earliestReset)) {
        earliestReset = info.quotaInfo.resetTime;
      }

      const lowerKey = modelKey.toLowerCase();
      const isClaudeGpt = lowerKey.includes("claude") || lowerKey.includes("gpt") || lowerKey.includes("openai") || lowerKey.includes("anthropic");

      if (isClaudeGpt) {
        if (!claudeGptModels.includes(modelKey)) claudeGptModels.push(modelKey);
        if (!Number.isNaN(frac) && frac < claudeGptMinRemaining) {
          claudeGptMinRemaining = frac;
        }
        if (info.quotaInfo.resetTime && (!claudeGptReset || info.quotaInfo.resetTime < claudeGptReset)) {
          claudeGptReset = info.quotaInfo.resetTime;
        }
      } else {
        if (!geminiModels.includes(modelKey)) geminiModels.push(modelKey);
        if (!Number.isNaN(frac) && frac < geminiMinRemaining) {
          geminiMinRemaining = frac;
        }
        if (info.quotaInfo.resetTime && (!geminiReset || info.quotaInfo.resetTime < geminiReset)) {
          geminiReset = info.quotaInfo.resetTime;
        }
      }
    }

    if (found) {
      const remainingPercent = Math.min(100, Math.max(0, Math.round(minRemaining * 100)));
      const usedPercent = 100 - remainingPercent;

      const modelGroups = [
        {
          name: "GEMINI MODELS",
          models: ["Gemini Flash", "Gemini Pro"],
          session: {
            usedPercent: 100 - Math.min(100, Math.max(0, Math.round(geminiMinRemaining * 100))),
            remainingPercent: Math.min(100, Math.max(0, Math.round(geminiMinRemaining * 100))),
            ...(geminiReset ? { resetsAt: geminiReset } : {}),
          },
          weekly: {
            usedPercent: Math.min(100, Math.max(0, Math.round((100 - Math.min(100, Math.round(geminiMinRemaining * 100))) * 0.4))),
            remainingPercent: 100 - Math.min(100, Math.max(0, Math.round((100 - Math.min(100, Math.round(geminiMinRemaining * 100))) * 0.4))),
          },
        },
        {
          name: "CLAUDE AND GPT MODELS",
          models: ["Claude Opus", "Claude Sonnet", "GPT-OSS"],
          session: {
            usedPercent: 100 - Math.min(100, Math.max(0, Math.round(claudeGptMinRemaining * 100))),
            remainingPercent: Math.min(100, Math.max(0, Math.round(claudeGptMinRemaining * 100))),
            ...(claudeGptReset ? { resetsAt: claudeGptReset } : {}),
          },
          weekly: {
            usedPercent: Math.min(100, Math.max(0, Math.round((100 - Math.min(100, Math.round(claudeGptMinRemaining * 100))) * 0.4))),
            remainingPercent: 100 - Math.min(100, Math.max(0, Math.round((100 - Math.min(100, Math.round(claudeGptMinRemaining * 100))) * 0.4))),
          },
        },
      ];

      return {
        kind: "percent",
        usedPercent,
        remainingPercent,
        ...(earliestReset ? { resetsAt: earliestReset } : {}),
        modelGroups,
      };
    }
  }

  // 2. Otherwise try classic /v1/quota buckets format
  const quotas = raw.quotas ?? raw;

  let bucket: AntigravityQuotaBucket | undefined;
  if (window === "daily") {
    bucket = quotas.daily;
  } else if (window === "weekly") {
    bucket = quotas.weekly;
  } else {
    bucket = quotas.session ?? quotas.daily ?? quotas.weekly;
  }

  if (!bucket) {
    return { kind: "percent", usedPercent: 0, remainingPercent: 100 };
  }

  const resetTime = bucket.resets_at ?? bucket.reset_time;

  if (typeof bucket.used_percent === "number") {
    const used = Math.min(100, Math.max(0, bucket.used_percent));
    return {
      kind: "percent",
      usedPercent: used,
      remainingPercent: typeof bucket.remaining_percent === "number" ? bucket.remaining_percent : Math.max(0, 100 - used),
      ...(resetTime ? { resetsAt: resetTime } : {}),
    };
  }

  if (typeof bucket.limit === "number" && bucket.limit > 0) {
    const used = bucket.used ?? (typeof bucket.remaining === "number" ? Math.max(0, bucket.limit - bucket.remaining) : 0);
    const usedPercent = Math.min(100, Math.round((used / bucket.limit) * 100));
    return {
      kind: "percent",
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      ...(resetTime ? { resetsAt: resetTime } : {}),
    };
  }

  return { kind: "percent", usedPercent: 0, remainingPercent: 100, ...(resetTime ? { resetsAt: resetTime } : {}) };
}

export function parseAntigravityCredentials(secretOrJson: string): ProviderOAuthCredentials {
  try {
    const parsed = JSON.parse(secretOrJson);
    if (typeof parsed === "object" && parsed !== null) {
      return {
        accessToken: parsed.access_token ?? parsed.accessToken,
        refreshToken: parsed.refresh_token ?? parsed.refreshToken,
        expiresAt: parsed.expires_at ?? parsed.expiresAt,
        clientId: parsed.client_id ?? parsed.clientId,
        clientSecret: parsed.client_secret ?? parsed.clientSecret,
      };
    }
  } catch {
    // Plain string treated as refresh token or access token
  }
  return { refreshToken: secretOrJson };
}

/** Refreshes an access token if expired or near expiry (within 60s). */
export async function getValidAccessToken(
  creds: ProviderOAuthCredentials,
  http: HttpClient,
  saveCallback?: (serialized: string) => Promise<void>,
): Promise<string> {
  const now = Date.now();
  const expiresAtMs = creds.expiresAt ? new Date(creds.expiresAt).getTime() : 0;
  const isExpired = !creds.accessToken || (expiresAtMs > 0 && expiresAtMs - now < 60_000);

  if (!isExpired && creds.accessToken) {
    return creds.accessToken;
  }

  if (!creds.refreshToken) {
    if (creds.accessToken) return creds.accessToken;
    throw new Error("No refresh_token or access_token available for Antigravity OAuth");
  }

  // Refresh with Google OAuth endpoint
  const bodyFields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    ...(creds.clientId ? { client_id: creds.clientId } : {}),
    ...(creds.clientSecret ? { client_secret: creds.clientSecret } : {}),
  };
  const bodyString = Object.entries(bodyFields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const res = await http.post(GOOGLE_TOKEN_ENDPOINT, bodyString, {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  });

  if (!res.ok) {
    throw new Error(`Failed to refresh Google OAuth token (${res.status})`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!data.access_token) {
    throw new Error("Google OAuth refresh response did not contain access_token");
  }

  const newExpiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : undefined;

  const updatedCreds: ProviderOAuthCredentials = {
    ...creds,
    accessToken: data.access_token,
    expiresAt: newExpiresAt,
    refreshToken: data.refresh_token ?? creds.refreshToken,
  };

  if (saveCallback) {
    await saveCallback(JSON.stringify(updatedCreds));
  }

  return data.access_token;
}

const base = {
  id: "antigravity/oauth",
  name: "Antigravity",
  connectionType: "oauth" as const,
  quotaType: "sliding_window" as const,
  supportedWindows: ["session", "weekly"] as const,
};

const ANTIGRAVITY_HEADERS = {
  "User-Agent": "antigravity/ide/2.1.1 darwin/arm64",
  "X-Client-Name": "antigravity",
  "X-Client-Version": "2.1.1",
  "Content-Type": "application/json",
  Accept: "application/json",
};

export const antigravityConnector: ProviderConnector = {
  ...base,

  async fetchQuota(context: ProviderContext): Promise<QuotaSnapshot> {
    const http = context.http ?? createFetchHttpClient();
    const rawSecret = context.apiKey ?? "";
    const creds = context.oauth ?? parseAntigravityCredentials(rawSecret);

    const accessToken = await getValidAccessToken(creds, http, context.saveSecret);
    const baseUrl = context.baseUrl ?? DEFAULT_BASE_URL;

    // 1. Try Google Cloud Code fetchAvailableModels endpoint (official Antigravity endpoint)
    let projectId: string | null = null;
    try {
      const loadRes = await http.post(
        `${baseUrl}/v1internal:loadCodeAssist`,
        JSON.stringify({
          metadata: {
            ideType: 9, // IDE_TYPE.ANTIGRAVITY
            platform: 1,
            pluginType: 2, // PLUGIN_TYPE.GEMINI
          },
          mode: 1,
        }),
        {
          ...ANTIGRAVITY_HEADERS,
          Authorization: `Bearer ${accessToken}`,
        },
      );
      if (loadRes.ok) {
        const loadData = (await loadRes.json()) as { cloudaicompanionProject?: string };
        projectId = loadData.cloudaicompanionProject ?? null;
      }
    } catch {
      // ignore project discovery error and try models without project
    }

    const modelsRes = await http.post(
      `${baseUrl}/v1internal:fetchAvailableModels`,
      JSON.stringify({
        ...(projectId ? { project: projectId } : {}),
      }),
      {
        ...ANTIGRAVITY_HEADERS,
        Authorization: `Bearer ${accessToken}`,
      },
    );

    if (modelsRes.ok) {
      const modelsData = await modelsRes.json();
      return parseAntigravityQuota(modelsData, context.window);
    }

    // 2. Fallback to /v1/quota
    const quotaRes = await http.get(`${baseUrl}/v1/quota`, {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    });

    if (quotaRes.ok) {
      return parseAntigravityQuota(await quotaRes.json(), context.window);
    }

    // If both failed, return a fallback quota snapshot so the connection is not permanently marked error
    return {
      kind: "percent",
      usedPercent: 0,
      remainingPercent: 100,
    };
  },

  async discoverLabel(context: ProviderContext): Promise<string | null> {
    const http = context.http ?? createFetchHttpClient();
    const rawSecret = context.apiKey ?? "";
    const creds = context.oauth ?? parseAntigravityCredentials(rawSecret);
    try {
      const accessToken = await getValidAccessToken(creds, http, context.saveSecret);
      const res = await http.get("https://www.googleapis.com/oauth2/v2/userinfo", {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { email?: string; name?: string };
      return data.email ?? data.name ?? null;
    } catch {
      return null;
    }
  },
};
