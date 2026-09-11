/**
 * Typed API client for the llm-quota SPA (Phase 6).
 *
 * Wraps the shared `HttpClient` (ADR-009) against the backend REST API
 * (ADR-008). Reads that take a body use the GET alias so the browser works
 * without a QUERY CORS preflight; the canonical QUERY contract stays on the
 * API/gateway side. Base URL comes from `VITE_API_URL`.
 */

import { createFetchHttpClient, type HttpClient } from "@llm-quota/shared";

export interface QuotaView {
  id: string;
  connectionId: string;
  kind: "percent" | "credits";
  usedPercent: number;
  remainingPercent: number;
  usedAmount?: number;
  remainingAmount?: number;
  currency?: string;
  resetAt?: string;
}

export interface ConnectionView {
  id: string;
  providerKey: string;
  label: string;
  connectionType: "api" | "oauth";
  status: "ok" | "error" | "unconfigured";
  createdAt: string;
}

export interface HistoryPoint {
  windowKey: string;
  spentAmount: number;
  currency: string;
}

/** Injected HTTP + config so the client is testable offline. */
export interface ApiOptions {
  http?: HttpClient;
  baseUrl?: string;
}

/** Resolve the API base URL, defaulting to a sane dev default. */
export function resolveApiBaseUrl(importMetaEnv: Record<string, string | undefined> = {}): string {
  return importMetaEnv.VITE_API_URL ?? "http://localhost:3000";
}

/** Typed client bound to a bearer token. */
export class ApiClient {
  private readonly http: HttpClient;
  private readonly base: string;

  constructor(private readonly token: string, opts: ApiOptions = {}) {
    this.http = opts.http ?? createFetchHttpClient();
    this.base = opts.baseUrl ?? resolveApiBaseUrl();
  }

  /** Authorization header for every request. */
  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async listQuotas(): Promise<QuotaView[]> {
    const res = await this.http.get(`${this.base}/v1/quotas`, this.auth());
    if (!res.ok) throw new Error(`quotas failed (${res.status})`);
    const body = (await res.json()) as { data: QuotaView[] };
    return body.data ?? [];
  }

  async listConnections(): Promise<ConnectionView[]> {
    const res = await this.http.get(`${this.base}/v1/connections`, this.auth());
    if (!res.ok) throw new Error(`connections failed (${res.status})`);
    const body = (await res.json()) as { data: ConnectionView[] };
    return body.data ?? [];
  }

  async createConnection(input: {
    providerId: string;
    label?: string;
    connectionType?: "api" | "oauth";
    secret: string;
  }): Promise<ConnectionView> {
    const body = JSON.stringify(input);
    const res = await this.http.post(
      `${this.base}/v1/connections`,
      body,
      { ...this.auth(), "Content-Type": "application/json" },
    );
    if (!res.ok) throw new Error(`create connection failed (${res.status})`);
    return (await res.json()) as ConnectionView;
  }

  /** History read via the GET alias (SPA compatibility, ADR-008). */
  async readHistory(params: { from?: string; to?: string } = {}): Promise<HistoryPoint[]> {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const q = qs.toString();
    const url = `${this.base}/v1/history${q ? `?${q}` : ""}`;
    const res = await this.http.get(url, this.auth());
    if (!res.ok) throw new Error(`history failed (${res.status})`);
    const body = (await res.json()) as { data: HistoryPoint[] };
    return body.data ?? [];
  }

  async listSessions(): Promise<{ id: string; createdAt: string }[]> {
    const res = await this.http.get(`${this.base}/v1/sessions`, this.auth());
    if (!res.ok) throw new Error(`sessions failed (${res.status})`);
    const body = (await res.json()) as { data: { id: string; createdAt: string }[] };
    return body.data ?? [];
  }
}
