import { test, expect } from "./support/fixtures.js";

test.describe("i18n journey", () => {
  test("switching to pt-BR re-labels the nav and persists across reload", async ({ seededPage, page }) => {
    await seededPage("/dashboard", { role: "user", locale: "pt-BR" });
    await expect(page.getByTestId("locale-switch")).toHaveValue("pt-BR");
    await page.reload();
    await expect(page.getByTestId("locale-switch")).toHaveValue("pt-BR");
    await expect(page.getByText(/painel/i).first()).toBeVisible();
  });

  test("switching back to en restores English chrome", async ({ seededPage, page }) => {
    await seededPage("/dashboard", { role: "user", locale: "en" });
    await expect(page.getByTestId("locale-switch")).toHaveValue("en");
  });
});

test.describe("theme journey", () => {
  test("toggle switches data-theme and persists across reload", async ({ seededPage, page }) => {
    await seededPage("/dashboard", { role: "user", theme: "light" });
    await page.getByRole("button", { name: /toggle color theme/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("persisted light survives a reload while stored", async ({ seededPage, page }) => {
    await seededPage("/dashboard", { role: "user", theme: "dark" });
    await page.getByRole("button", { name: /toggle color theme/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
