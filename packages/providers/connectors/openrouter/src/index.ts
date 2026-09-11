import type { ProviderConnector, ProviderContext } from "@llm-quota/providers";

/**
 * OpenRouter (API) connector — declared in Phase 3 as a second concrete
 * connector that validates the `ProviderConnector` pattern with two providers.
 * This is the Phase 0 marker/contract so the package typechecks.
 */
export const openRouterConnector: ProviderConnector = {
  id: "openrouter/api",
  name: "OpenRouter",
  connectionType: "api",
  async fetchQuota(_context: ProviderContext) {
    // Phase 3: implement real quota read.
    throw new Error("Not implemented in Phase 0");
  },
  async discoverLabel(_context: ProviderContext) {
    return null;
  },
};
