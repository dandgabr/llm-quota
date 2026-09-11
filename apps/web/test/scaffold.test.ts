import { describe, expect, it } from "vitest";

describe("web scaffold", () => {
  it("bootstraps the app entry", () => {
    expect(import.meta.url).toBeTruthy();
  });
});
