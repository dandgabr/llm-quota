/**
 * Provider connector framework for llm-quota.
 *
 * Phase 3: the `ProviderConnector` contract (producing a raw `QuotaSnapshot`),
 * an injectable `HttpClient` so connectors are testable without real network,
 * and the `ProviderRegistry` (provider-management integrator / routing).
 */

import type { ConnectionType, Quota } from "@llm-quota/shared";

/**
 * Raw quota response a connector reads from its provider, in a shape the core
 * normalizes (via `summarizeQuota`) into a `QuotaSummary`. Structurally the
 * shared `Quota` union; kept as a named alias so the connector contract is
 * explicit and the wire shape is testable.
 */
export type QuotaSnapshot = Quota;

/** Minimal HTTP response surface the connectors rely on. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Minimal HTTP client so connectors run on `fetch` in prod and a stub in tests. */
export interface HttpClient {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
}

/** The fetch-like function injected into `createFetchHttpClient`. */
type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Default fetch implementation. `globalThis.fetch` is available at runtime on
 * Node >= 22; the base TS lib is ES2022 (no DOM) so it is read via a cast.
 */
/** Global fetch impl, read via `unknown` cast (ES2022 lib has no DOM fetch). */
const defaultFetch = (globalThis as unknown as { fetch?: FetchFn }).fetch;

/** Real `fetch`-backed HttpClient (Node >= 22 global fetch). */
export const createFetchHttpClient = (fetchFn: FetchFn = defaultFetch!): HttpClient => ({
  async get(url, headers) {
    const res = await fetchFn(url, { method: "GET", headers });
    return {
      status: res.status,
      ok: res.ok,
      json: () => res.json(),
      text: () => res.text(),
    };
  },
});

/** Context a connector needs to read a quota for one connection. */
export interface ProviderContext {
  /** The user-saved connection being read. */
  connectionId: string;
  /** Whether this connection uses OAuth or an API key. */
  connectionType: ConnectionType;
  /** API key / secret for `api` connections. Never logged. */
  apiKey?: string;
  /** Overridable base URL for the connector endpoint (env config). */
  baseUrl?: string;
  /** Injectable HTTP client; defaults to `fetch`. */
  http?: HttpClient;
}

export interface ProviderConnector {
  /** Stable connector id, e.g. `ollama-claude/api`. */
  readonly id: string;
  /** Human-readable provider name. */
  readonly name: string;
  /** Connection type this connector satisfies. */
  readonly connectionType: ConnectionType;
  /** Read the current quota for a connection and return the raw snapshot. */
  fetchQuota(context: ProviderContext): Promise<QuotaSnapshot>;
  /** Best-effort label autodetection for a connection (optional). */
  discoverLabel?(context: ProviderContext): Promise<string | null>;
}

/** Registry / integrator that routes by provider id + connection type. */
export class ProviderRegistry {
  private readonly connectors = new Map<string, ProviderConnector>();

  /** Register a connector under its stable id (`providerKey/connectionType`). */
  register(connector: ProviderConnector): void {
    this.connectors.set(connector.id, connector);
  }

  /** Look up a connector by exact id (`providerKey/connectionType`). */
  get(id: string): ProviderConnector | undefined {
    return this.connectors.get(id);
  }

  /** All connectors for a provider key (e.g. all `openrouter/*` types). */
  resolve(providerKey: string): ProviderConnector[] {
    return this.list().filter((c) => c.id.startsWith(`${providerKey}/`));
  }

  /** Return all registered connectors. */
  list(): ProviderConnector[] {
    return [...this.connectors.values()];
  }
}
