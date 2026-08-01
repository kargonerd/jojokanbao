import { expect, test } from "@playwright/test";

test("search sort uses the editorial dropdown and sends the selected sort", async ({ page }) => {
  const requests: string[] = [];
  await page.route("https://s1.jojokanbao.cn/search**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          total: 1,
          results: [
            {
              title: "测试标题",
              content: "测试内容",
              date: "1966-07-01",
              page: 5,
            },
          ],
        },
      }),
    });
  });

  await page.goto("/search?keyword=测试", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "测试标题" })).toBeVisible();

  const sortButton = page.getByRole("button", { name: "默认排序" });
  await sortButton.click();
  const listbox = page.getByRole("listbox", { name: "排序" });
  await expect(listbox).toBeVisible();
  await expect(page.getByRole("option", { name: "默认排序" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("option", { name: "时间降序" }).click();
  await expect(page.getByRole("button", { name: "时间降序" })).toBeVisible();
  await expect.poll(() => requests.some((url) => new URL(url).searchParams.get("sort") === "timeDesc")).toBe(true);

  await page.getByRole("button", { name: "时间降序" }).click();
  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);

  await page.getByRole("button", { name: "时间降序" }).click();
  await page.mouse.click(8, 180);
  await expect(listbox).toHaveCount(0);
});

test("search date filters use the new value and pagination returns to the results top", async ({ page }) => {
  const requests: string[] = [];
  const results = Array.from({ length: 10 }, (_, index) => ({
    title: `测试标题 ${index + 1}`,
    content: "用于验证搜索结果内部滚动。".repeat(80),
    date: "1966-07-01",
    page: index + 1,
  }));
  await page.route("https://s1.jojokanbao.cn/search**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { total: 25, results } }),
    });
  });

  await page.goto("/search?keyword=测试&startDate=20260716&endDate=20260717", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "测试标题 1", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "日期范围：2026-07-16 — 2026-07-17" }).click();
  await page.getByRole("button", { name: "开始日期：打开日历" }).click();
  await page.getByRole("button", { name: "15", exact: true }).click();
  await page.getByRole("button", { name: "应用" }).click();
  await expect.poll(() => {
    const lastRequest = requests.at(-1);
    return lastRequest ? new URL(lastRequest).searchParams.get("startDate") : null;
  }).toBe("2026-07-15");

  await page.getByRole("button", { name: "清除日期" }).click();
  await expect.poll(() => {
    const lastRequest = requests.at(-1);
    if (!lastRequest) return "pending";
    const params = new URL(lastRequest).searchParams;
    return `${params.get("startDate")}:${params.get("endDate")}`;
  }).toBe("null:null");
  await expect(page.getByRole("button", { name: "日期范围：选择日期范围" })).toBeVisible();

  await page.getByRole("button", { name: "日期范围：选择日期范围" }).click();
  await page.getByRole("textbox", { name: "开始日期" }).fill("1946.9.25");
  await page.getByRole("textbox", { name: "开始日期" }).press("Enter");
  await page.getByRole("textbox", { name: "结束日期" }).fill("1960.5.6");
  await page.getByRole("textbox", { name: "结束日期" }).press("Enter");
  await page.getByRole("button", { name: "应用" }).click();
  await expect.poll(() => {
    const lastRequest = requests.at(-1);
    if (!lastRequest) return "pending";
    const params = new URL(lastRequest).searchParams;
    return `${params.get("startDate")}:${params.get("endDate")}`;
  }).toBe("1946-09-25:1960-05-06");

  await page.getByRole("button", { name: "日期范围：1946-09-25 — 1960-05-06" }).click();
  await page.getByRole("button", { name: "大跃进" }).click();
  await expect.poll(() => {
    const lastRequest = requests.at(-1);
    if (!lastRequest) return "pending";
    const params = new URL(lastRequest).searchParams;
    return `${params.get("startDate")}:${params.get("endDate")}`;
  }).toBe("1958-01-01:1960-12-31");

  const scrollContainer = page.locator("[data-search-scroll-container]");
  await scrollContainer.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await scrollContainer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "›" }).click();
  await expect.poll(() => scrollContainer.evaluate((element) => element.scrollTop)).toBeLessThan(5);
  expect(new URL(requests.at(-1)!).searchParams.get("page")).toBe("2");
});
