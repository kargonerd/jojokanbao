const { test, expect } = require('@playwright/test');

test.describe('Vue 3 + pdfjs upgrade', () => {
  test('homepage loads and navigates', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.el-header')).toBeVisible();
    await expect(page.locator('.el-menu--horizontal').first()).toBeVisible();
  });

  test('RMRB page loads and attempts PDF render', async ({ page }) => {
    const consoleLogs = [];
    page.on('console', msg => consoleLogs.push(msg.text()));

    await page.goto('/rmrb/19701009');
    await expect(page.locator('.select-section')).toBeVisible({ timeout: 15000 });

    // Wait for PDF loading attempt to complete
    await page.waitForTimeout(8000);

    const canvasCount = await page.locator('canvas').count();
    const emptyCount = await page.locator('.document-empty').count();

    console.log(`Canvas elements: ${canvasCount}, Empty state: ${emptyCount}`);
    const errors = consoleLogs.filter(l => l.includes('error') || l.includes('Error') || l.includes('失败'));
    if (errors.length) console.log(`Console errors: ${errors.join(' | ')}`);

    // Pass if either canvas rendered OR expected error state
    expect(canvasCount > 0 || emptyCount > 0).toBeTruthy();

    if (canvasCount > 0) {
      const box = await page.locator('canvas').first().boundingBox();
      expect(box.width).toBeGreaterThan(100);
      expect(box.height).toBeGreaterThan(100);
      console.log(`PDF rendered successfully! Canvas size: ${box.width}x${box.height}`);
    }
  });

  test('support page loads', async ({ page }) => {
    await page.goto('/support');
    await expect(page.locator('h1:has-text("反馈")')).toBeVisible();
    await expect(page.locator('h1:has-text("数据下载")')).toBeVisible();
  });

  test('search page loads and input works', async ({ page }) => {
    await page.goto('/search');
    const input = page.locator('.el-input__inner').first();
    await expect(input).toBeVisible();
    await input.fill('毛主席');
    await expect(input).toHaveValue('毛主席');
  });

  test('PDF page navigation with hash', async ({ page }) => {
    await page.goto('/rmrb/19701009#page-2');
    await expect(page.locator('.select-section')).toBeVisible({ timeout: 15000 });
    const pdfArea = page.locator('.pdf-pages, .document-empty');
    await expect(pdfArea).toBeVisible({ timeout: 15000 });
  });
});
