/**
 * Provider connector framework for llm-quota.
 *
 * Phase 0 scaffold: the `ProviderConnector` contract and a `ProviderRegistry`
 * (the provider-management integrator). Concrete connectors land in Phase 3.
 */

import type { Quota } from "@llm-quota/shared";

export interface ProviderContext {
  /** The user-saved connection being read. */
  connectionId: string;
  /** Whether this connection uses OAuth or an API key. */
  connectionType: "oauth" | "api";
}

export interface ProviderConnector {
  /** Stable connector id, e.g. `ollama-claude/api`. */
  readonly id: string;
  /** Human-readable provider name. */
  readonly name: string;
  /** Whether this connector requires OAuth or an API key. */
  readonly connectionType: "oauth" | "api";
  /** Attempt to read the current quota for a connection. */
  fetchQuota(context: ProviderContext): Promise<Quota>;
  /** Best-effort label autodetection for a connection (optional). */
  discoverLabel?(context: ProviderContext): Promise<string | null>;
}

/** Registry / integrator that routes by provider id + connection type. */
export class ProviderRegistry {
  private readonly connectors = new Map<string, ProviderConnector>();

  /** Register a connector under its stable id. */
  register(connector: ProviderConnector): void {
    this.connectors.set(connector.id, connector);
  }

  /** Look up a connector by id, or undefined when not registered. */
  get(id: string): ProviderConnector | undefined {
    return this.connectors.get(id);
  }

  /** Return all registered connectors. */
  list(): ProviderConnector[] {
    return [...this.connectors.values()];
  }
}
