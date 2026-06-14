import { test, expect } from "@playwright/test";

test.describe("RAG App", () => {
  test("redirects / to /chat", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/chat");
  });

  test("chat page loads with sidebar and input", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByText("知识库")).toBeVisible();
    await expect(page.getByPlaceholder("输入问题...")).toBeVisible();
    await expect(page.getByText("发送")).toBeVisible();
  });

  test("empty state shows prompt", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByText("有什么想问的？")).toBeVisible();
  });

  test("admin page shows login when unauthenticated", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByText("管理后台")).toBeVisible();
    await expect(page.getByPlaceholder("输入密码")).toBeVisible();
  });
});
