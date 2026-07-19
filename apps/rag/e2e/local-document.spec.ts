import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

const documentPath = process.env.RAG_E2E_DOCUMENT ?? "";

test("uploads the configured Markdown and completes a simplified-Chinese question flow", async ({ page }) => {
  test.skip(!documentPath || !existsSync(documentPath), "Set RAG_E2E_DOCUMENT to an existing Markdown file");

  const healthResponse = await page.request.get("/api/health");
  const health = await healthResponse.json() as {
    data: { agent: { mode: string; model: string; configured: boolean } };
  };

  await page.goto("/documents");
  await expect(page.getByText(health.data.agent.model)).toBeVisible();
  const registeredDocument = page.getByRole("heading", { name: "革命造反年代" });
  if ((await registeredDocument.count()) === 0) {
    await page.locator('input[type="file"]').setInputFiles(documentPath);
    await expect(page.getByRole("button", { name: /MinerU_markdown_TheAgeOfRevolution/ })).toBeVisible();
    await page.getByRole("button", { name: "添加文档" }).click();

    await expect(page.getByText("已添加《革命造反年代》")).toBeVisible({ timeout: 20_000 });
  }
  await expect(registeredDocument.first()).toBeVisible();

  await page.getByRole("link", { name: "去提问" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("checkbox").first()).toBeChecked();

  await page.getByPlaceholder("输入问题，Enter 发送…").fill("这本书的书名和作者是谁？请给出原文行号。");
  await page.getByRole("button", { name: "提问" }).click();

  if (health.data.agent.mode === "mock") {
    await expect(page.getByText("本地问答链路已经连通。", { exact: false })).toBeVisible({ timeout: 20_000 });
  } else {
    await expect(page.getByText("李逊", { exact: false })).toBeVisible({ timeout: 120_000 });
  }
  await expect(page.locator("[data-document-id]").first()).toBeVisible();
  await expect(page.getByText(health.data.agent.mode === "codex" ? "API 等价估算" : "模型估算")).toBeVisible();
  await expect(page.getByText("SCF 基础估算")).toBeVisible();
  await expect(page.getByText(/^\$\d+\.\d{5}$/)).toBeVisible();
  await expect(page.getByText(/^¥\d+\.\d{4}$/)).toBeVisible();
});
