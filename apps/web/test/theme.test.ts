// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { resolveInitialTheme, useTheme } from "../src/lib/theme.js";

function clearStored() {
  localStorage.removeItem("llm-quota.theme");
}

describe("useTheme", () => {
  beforeEach(() => {
    clearStored();
  });

  it("defaults to light without a preference or matchMedia", () => {
    // jsdom has no matchMedia by default -> falls back to light.
    expect(resolveInitialTheme()).toBe("light");
  });

  it("prefers a persisted choice over the system", () => {
    localStorage.setItem("llm-quota.theme", "dark");
    expect(resolveInitialTheme()).toBe("dark");
  });

  it("toggles between light and dark and persists", () => {
    const { ui, toggle, init } = useTheme();
    init();
    const before = ui.theme;
    toggle();
    expect(ui.theme).toBe(before === "light" ? "dark" : "light");
    expect(localStorage.getItem("llm-quota.theme") === "dark" || localStorage.getItem("llm-quota.theme") === "light").toBe(true);
  });

  it("sets the data-theme attribute on <html>", () => {
    const { toggle, init } = useTheme();
    init();
    toggle("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    toggle("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
