import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./support/fixtures.js";

test.describe("accessibility (WCAG 2.2 AA — ADR-011)", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`no axe color-contrast violations on dashboard (${theme})`, async ({ seededPage, page }) => {
      await seededPage("/dashboard", { role: "user", theme });
      const results = await new AxeBuilder({ page }).analyze();
      const contrast = results.violations.filter((v) => v.id === "color-contrast");
      expect(contrast).toEqual([]);
    });

    test(`no critical axe violations on login (${theme})`, async ({ seededPage, page }) => {
      await seededPage("/login", { anonymous: true, theme });
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const critical = results.violations.filter((v) => v.impact === "critical");
      expect(critical).toEqual([]);
    });
  }

  test("focus is visible when tabbing through the topbar", async ({ seededPage, page }) => {
    await seededPage("/dashboard", { role: "user" });
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press("Tab");
      const outline = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? getComputedStyle(el).outlineStyle : "none";
      });
      expect(outline).not.toBe("none");
    }
  });

  test("prefers-reduced-motion disables the skeleton animation", async ({ seededPage, page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await seededPage("/dashboard", { role: "user", anonymous: false });
    // After load the skeleton is gone; assert via computed style on a forced one.
    const anim = await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "skeleton";
      document.body.appendChild(el);
      const name = getComputedStyle(el).animationName;
      el.remove();
      return name;
    });
    expect(anim).toBe("none");
  });
});
