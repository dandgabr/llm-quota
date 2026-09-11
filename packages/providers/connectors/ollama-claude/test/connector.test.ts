import { describe, expect, it } from "vitest";
import { ollamaClaudeConnector } from "../src/index.js";

describe("ollamaClaudeConnector", () => {
  it("registers under the expected provider id", () => {
    expect(ollamaClaudeConnector.id).toBe("ollama-claude/api");
    expect(ollamaClaudeConnector.connectionType).toBe("api");
  });
});
