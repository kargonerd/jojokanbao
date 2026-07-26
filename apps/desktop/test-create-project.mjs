import { chromium } from 'playwright';

async function waitForProjectCreation(page) {
  const response = await page.waitForResponse((candidate) => candidate.url().includes('/projects') && candidate.request().method() === 'POST');
  const payload = await response.json();
  return payload.project_id ?? null;
}

async function testCreateProject() {
  console.log('Testing create project with MinerU...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    console.log('=== Step 1: Open Home Page ===');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    console.log('Page loaded:', page.url());

    console.log('\n=== Step 2: Click Create Project Button ===');
    const createButton = page.locator('button:has-text("选择 PDF 文件")');
    console.log('Button found:', await createButton.count() > 0);

    if (await createButton.count() === 0) {
      console.log('Create button not found');
      await browser.close();
      return;
    }

    const projectCreation = waitForProjectCreation(page);
    await createButton.click();
    console.log('Button clicked, waiting for project creation...');

    console.log('\n=== Step 3: Check Navigation ===');
    const projectId = await projectCreation;
    console.log('Project ID:', projectId);

    if (!projectId) {
      const pageText = await page.locator('body').textContent();
      console.log('Page content:', pageText.substring(0, 500));
      await page.screenshot({ path: 'create-project-failed.png', timeout: 5000 });
      console.log('Screenshot saved to create-project-failed.png');
      await browser.close();
      return;
    }

    await page.getByRole('heading', { name: '确认书籍信息' }).waitFor({ timeout: 30000 });
    console.log('✓ Project created successfully!');

    await page.getByRole('button', { name: '确认并进入校对' }).click();
    await page.getByRole('heading', { name: '文字校对' }).waitFor({ timeout: 30000 });
    console.log('✓ Proofread page opened!');

    const bodyText = await page.locator('body').textContent();
    const pageMatch = bodyText.match(/第\s*(\d+)\s*页/);
    console.log('Current proofread page:', pageMatch ? pageMatch[1] : '0');

    await page.screenshot({ path: 'project-status.png', timeout: 5000 });
    console.log('Screenshot saved to project-status.png');

    await browser.close();
    console.log('\n=== Test Completed ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

testCreateProject();
