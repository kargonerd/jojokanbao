import { chromium } from 'playwright';

async function testCompleteFlow() {
  console.log('Testing complete flow...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    // 1. 创建新项目
    console.log('=== Step 1: Create New Project ===');
    await page.goto('http://127.0.0.1:4173/');
    await page.waitForTimeout(2000);

    const createButton = await page.locator('button:has-text("选择 PDF 文件")');
    await createButton.click();
    console.log('Clicked create button');

    // 等待项目创建和识别
    await page.waitForTimeout(10000);

    // 检查是否跳转到了项目页面
    let currentUrl = page.url();
    console.log('Current URL after create:', currentUrl);

    // 获取项目ID
    const projectIdMatch = currentUrl.match(/\/projects\/([a-zA-Z0-9_]+)/);
    const projectId = projectIdMatch ? projectIdMatch[1] : null;
    console.log('Project ID:', projectId);

    if (!projectId) {
      console.log('Failed to get project ID');
      await browser.close();
      return;
    }

    // 2. 等待识别完成
    console.log('\n=== Step 2: Wait for Recognition ===');
    let recognitionCompleted = false;
    let attempts = 0;
    const maxAttempts = 60; // 最多等待2分钟

    while (!recognitionCompleted && attempts < maxAttempts) {
      await page.reload();
      await page.waitForTimeout(2000);

      const bodyText = await page.locator('body').textContent();
      const status = bodyText.includes('识别完成') ? 'Completed' :
                     bodyText.includes('识别中') ? 'Processing' :
                     bodyText.includes('排队中') ? 'Queued' : 'Unknown';
      console.log(`Attempt ${attempts + 1}: ${status}`);

      if (bodyText.includes('识别完成')) {
        recognitionCompleted = true;
        break;
      }

      attempts++;
    }

    if (!recognitionCompleted) {
      console.log('Recognition did not complete in time');
      await browser.close();
      return;
    }

    console.log('✓ Recognition completed');

    // 3. 点击查看识别结果
    console.log('\n=== Step 3: View Recognition Result ===');
    const viewButton = await page.locator('a:has-text("查看识别结果")');
    if (await viewButton.count() > 0) {
      await viewButton.click();
      await page.waitForTimeout(3000);
      console.log('Navigated to metadata page');
    }

    // 4. 确认元数据
    console.log('\n=== Step 4: Confirm Metadata ===');
    const confirmButton = await page.locator('button:has-text("确认")');
    if (await confirmButton.count() > 0) {
      await confirmButton.click();
      await page.waitForTimeout(3000);
      console.log('Confirmed metadata');
    }

    // 5. 测试校对页面
    console.log('\n=== Step 5: Test Proofread Page ===');
    await page.goto(`http://127.0.0.1:4173/projects/${projectId}/proofread`);
    await page.waitForTimeout(3000);

    console.log('Proofread page URL:', page.url());

    // 截图
    try {
      await page.screenshot({ path: 'proofread-final-test.png', timeout: 5000 });
      console.log('Screenshot saved');
    } catch (e) {
      console.log('Screenshot timeout');
    }

    // 分析页面
    const bodyText = await page.locator('body').textContent();
    console.log('\n=== Page Analysis ===');
    console.log('Contains "文字校对":', bodyText.includes('文字校对'));
    console.log('Contains "原始 PDF":', bodyText.includes('原始 PDF'));
    console.log('Contains "识别结果":', bodyText.includes('识别结果'));

    const iframeCount = await page.locator('iframe').count();
    const textareaCount = await page.locator('textarea').count();
    console.log('iframe count (PDF):', iframeCount);
    console.log('textarea count (edit):', textareaCount);

    console.log('\nPage preview (first 600 chars):');
    console.log(bodyText.substring(0, 600));

    await browser.close();
    console.log('\n=== Test Completed ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

testCompleteFlow();
