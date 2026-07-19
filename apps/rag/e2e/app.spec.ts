import { test, expect } from "@playwright/test";

test.describe("RAG App", () => {
  test("redirects / to /chat", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/chat");
  });

  test("chat page loads with sidebar and input", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByText("本次查阅")).toBeVisible();
    await expect(page.getByLabel("主导航").getByRole("link", { name: "文档管理" })).toBeVisible();
  });

  test("empty state shows prompt", async ({ page }) => {
    await page.route("**/api/documents", (route) => route.fulfill({ json: { success: true, data: [] } }));
    await page.goto("/chat");
    await expect(page.getByText(/先放一份原文进来|不先切碎/)).toBeVisible();
  });

  test("admin redirects to local document management", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL("/documents");
    await expect(page.getByText("登记一份原始文档")).toBeVisible();
  });
});
