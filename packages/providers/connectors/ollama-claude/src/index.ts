import type { ProviderConnector, ProviderContext } from "@llm-quota/providers";

/**
 * Ollama Claude connector — declared in Phase 3 as the first concrete
 * connector. This is the Phase 0 marker/contract so the package typechecks.
 */
export const ollamaClaudeConnector: ProviderConnector = {
  id: "ollama-claude/api",
  name: "Ollama Claude",
  connectionType: "api",
  /** Reads the Ollama Claude quota for a connection (Phase 3 implementation). */
  async fetchQuota(_context: ProviderContext) {
    // Phase 3: implement real quota read.
    throw new Error("Not implemented in Phase 0");
  },
  /** Best-effort label autodetection (Phase 3 implementation). */
  async discoverLabel(_context: ProviderContext) {
    return null;
  },
};
