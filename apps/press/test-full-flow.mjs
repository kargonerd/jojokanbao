import { chromium } from 'playwright';

async function waitForProjectCreation(page) {
  const response = await page.waitForResponse((candidate) => candidate.url().includes('/projects') && candidate.request().method() === 'POST');
  const payload = await response.json();
  return payload.project_id ?? null;
}

async function testFullFlow() {
  console.log('Testing full flow...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    console.log('=== Step 1: Create New Project ===');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const createButton = page.locator('button:has-text("选择 PDF 文件")');
    const projectCreation = waitForProjectCreation(page);
    await createButton.click();
    console.log('Clicked create button');

    const projectId = await projectCreation;
    console.log('Project ID:', projectId);

    if (!projectId) {
      console.log('Failed to get project ID');
      await browser.close();
      return;
    }

    await page.getByRole('heading', { name: '确认书籍信息' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '确认并进入校对' }).click();

    console.log('\n=== Step 2: Test Proofread Page ===');
    await page.getByRole('heading', { name: '文字校对' }).waitFor({ timeout: 30000 });

    const bodyText = await page.locator('body').textContent();
    const pageMatch = bodyText.match(/第\s*(\d+)\s*页/);
    console.log('Current proofread page:', pageMatch ? pageMatch[1] : '0');

    const iframeCount = await page.locator('iframe').count();
    const textareaCount = await page.locator('textarea').count();
    console.log('iframe count:', iframeCount);
    console.log('textarea count:', textareaCount);

    try {
      await page.screenshot({ path: 'proofread-final-test.png', timeout: 5000 });
      console.log('Screenshot saved');
    } catch (e) {
      console.log('Screenshot timeout');
    }

    await browser.close();
    console.log('\n=== Test Completed ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

testFullFlow();
