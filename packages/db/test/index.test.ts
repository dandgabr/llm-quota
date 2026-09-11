import { describe, expect, it } from "vitest";
import { resolveDatabaseConfig } from "../src/index.js";

describe("resolveDatabaseConfig", () => {
  it("throws when DATABASE_URL is missing", () => {
    expect(() => resolveDatabaseConfig({})).toThrow(/DATABASE_URL/);
  });

  it("reads the connection url", () => {
    const config = resolveDatabaseConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db" });
    expect(config.url).toContain("localhost");
  });
});
