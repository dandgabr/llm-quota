import { describe, expect, it } from "vitest";
import { ProviderRegistry, type ProviderConnector } from "../src/index.js";

const fakeConnector: ProviderConnector = {
  id: "fake/api",
  name: "Fake",
  connectionType: "api",
  async fetchQuota() {
    return { kind: "percent", usedPercent: 10, remainingPercent: 90 };
  },
};

describe("ProviderRegistry", () => {
  it("registers and looks up connectors by id", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeConnector);
    expect(registry.get("fake/api")).toBe(fakeConnector);
  });

  it("lists registered connectors", () => {
    const registry = new ProviderRegistry();
    registry.register(fakeConnector);
    expect(registry.list()).toContain(fakeConnector);
  });
});
