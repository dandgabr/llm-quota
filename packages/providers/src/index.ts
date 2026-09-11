/**
 * Provider connector framework for llm-quota.
 *
 * Phase 3: the `ProviderConnector` contract (producing a raw `QuotaSnapshot`),
 * an injectable `HttpClient` so connectors are testable without real network,
 * and the `ProviderRegistry` (provider-management integrator / routing).
 */

import type { ConnectionType, Quota } from "@llm-quota/shared";
import { type HttpClient, createFetchHttpClient as sharedCreateFetch } from "@llm-quota/shared";

/**
 * Raw quota response a connector reads from its provider, in a shape the core
 * normalizes (via `summarizeQuota`) into a `QuotaSummary`. Structurally the
 * shared `Quota` union; kept as a named alias so the connector contract is
 * explicit and the wire shape is testable.
 */
export type QuotaSnapshot = Quota;

/** HTTP client contract, shared across connectors and OIDC (ADR-009). */
export type { HttpClient, HttpResponse } from "@llm-quota/shared";

/** Real `fetch`-backed HttpClient (Node >= 22 global fetch). */
export const createFetchHttpClient: typeof sharedCreateFetch = sharedCreateFetch;

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
