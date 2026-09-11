import { describe, expect, it } from "vitest";
import { openRouterConnector } from "../src/index.js";

describe("openRouterConnector", () => {
  it("registers under the expected provider id", () => {
    expect(openRouterConnector.id).toBe("openrouter/api");
    expect(openRouterConnector.connectionType).toBe("api");
  });
});
