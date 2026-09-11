import { test, expect } from "./support/fixtures.js";

test.describe("admin RBAC journey", () => {
  test("user role is redirected away from /admin", async ({ seededPage, page }) => {
    await seededPage("/admin", { role: "user" });
    await expect(page).toHaveURL(/\/$/);
  });

  test("supervisor role is also redirected away from /admin", async ({ seededPage, page }) => {
    await seededPage("/admin", { role: "supervisor" });
    await expect(page).toHaveURL(/\/$/);
  });

  test("admin sees the admin console", async ({ seededPage, page }) => {
    await seededPage("/admin", { role: "admin" });
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText(/connections:/i)).toBeVisible();
  });
});
