import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  type ProviderConnector,
  type ProviderContext,
  type QuotaSnapshot,
} from "../src/index.js";

// A fake provider connector stub, used to validate routing independent of the
// concrete connectors' network behaviour.
const fakeConnector = (
  id: string,
  connectionType: "api" | "oauth",
  snapshot: QuotaSnapshot,
): ProviderConnector => ({
  id,
  name: id,
  connectionType,
  async fetchQuota(_context: ProviderContext): Promise<QuotaSnapshot> {
    return snapshot;
  },
});

describe("ProviderRegistry routing", () => {
  it("routes by providerId + connectionType via the composite id", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeConnector("openai/codex", "api", { kind: "percent", usedPercent: 10, remainingPercent: 90 }));
    registry.register(fakeConnector("openai/oauth", "oauth", { kind: "credits", currency: "USD", total: 100 }));

    const api = registry.get("openai/codex");
    const oauth = registry.get("openai/oauth");
    expect(api?.connectionType).toBe("api");
    expect(oauth?.connectionType).toBe("oauth");
  });

  it("supports multiple connection types per provider", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeConnector("openai/codex", "api", { kind: "percent", usedPercent: 10, remainingPercent: 90 }));
    registry.register(fakeConnector("openai/oauth", "oauth", { kind: "credits", currency: "USD", total: 100 }));

    const all = registry.resolve("openai");
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.connectionType).sort()).toEqual(["api", "oauth"]);
  });

  it("returns undefined for unknown ids", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeConnector("ollama-claude/api", "api", { kind: "percent", usedPercent: 0, remainingPercent: 100 }));
    expect(registry.get("nope/nope")).toBeUndefined();
  });
});
