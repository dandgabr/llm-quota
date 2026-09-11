import { describe, expect, it } from "vitest";
import { defaultPort, readConfig } from "../src/index.js";

describe("readConfig", () => {
  it("defaults the port when PORT is missing", () => {
    expect(readConfig({}).port).toBe(defaultPort);
  });

  it("parses PORT from the environment", () => {
    expect(readConfig({ PORT: "8080" }).port).toBe(8080);
  });

  it("defaults the environment to development", () => {
    expect(readConfig({}).env).toBe("development");
  });
});
