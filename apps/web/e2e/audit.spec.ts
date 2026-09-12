import { expect, test } from "./support/fixtures.js";

/**
 * Phase B — audit trail journey against the hermetic API stub.
 * A supervisor can read events and expand metadata; a user cannot reach it.
 */
test.describe("audit trail", () => {
  test("supervisor sees events and expands metadata", async ({ seededPage, page }) => {
    await seededPage("/admin/audit", { role: "supervisor" });
    await expect(page.getByRole("heading", { name: /audit log/i })).toBeVisible();
    await expect(page.getByText("user.role_changed")).toBeVisible();
    await page.getByRole("button", { name: /details/i }).click();
    await expect(page.getByText("supervisor", { exact: false })).toBeVisible();
  });

  test("a plain user is redirected away from the audit log", async ({ seededPage, page }) => {
    await seededPage("/admin/audit", { role: "user" });
    await expect(page).toHaveURL(/\/$/);
  });
});
