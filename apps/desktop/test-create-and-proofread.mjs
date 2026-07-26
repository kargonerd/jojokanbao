import { chromium } from 'playwright';

async function testCreateAndProofread() {
  console.log('Creating new project and testing proofread page...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    // 1. 创建新项目
    console.log('=== Step 1: Create New Project ===');
    await page.goto('http://127.0.0.1:4175/');
    await page.waitForTimeout(2000);

    const createButton = await page.locator('button:has-text("选择 PDF 文件")');
    await createButton.click();
    console.log('Clicked create button');

    // 等待项目创建
    await page.waitForTimeout(5000);

    // 获取项目ID
    const currentUrl = page.url();
    const projectIdMatch = currentUrl.match(/\/projects\/([a-zA-Z0-9_]+)/);
    const projectId = projectIdMatch ? projectIdMatch[1] : null;
    console.log('Project ID:', projectId);

    if (!projectId) {
      console.log('Failed to get project ID from URL:', currentUrl);
      // 尝试从页面内容获取
      const pageText = await page.locator('body').textContent();
      console.log('Page text:', pageText.substring(0, 300));
      await browser.close();
      return;
    }

    // 2. 等待识别完成
    console.log('\n=== Step 2: Wait for Recognition ===');
    let recognitionCompleted = false;
    let attempts = 0;
    const maxAttempts = 120;

    while (!recognitionCompleted && attempts < maxAttempts) {
      await page.reload();
      await page.waitForTimeout(2000);

      const pageText = await page.locator('body').textContent();

      if (pageText.includes('识别完成')) {
        console.log('\n✓ Recognition completed!');
        recognitionCompleted = true;
        break;
      } else if (pageText.includes('识别中')) {
        process.stdout.write(`\rAttempt ${attempts + 1}: Processing...`);
      } else if (pageText.includes('排队中')) {
        process.stdout.write(`\rAttempt ${attempts + 1}: Queued...`);
      } else if (pageText.includes('失败')) {
        console.log('\n✗ Recognition failed');
        break;
      }

      attempts++;
    }

    if (!recognitionCompleted) {
      console.log('\nRecognition did not complete in time');
      await browser.close();
      return;
    }

    // 3. 进入校对页面
    console.log('\n=== Step 3: Navigate to Proofread Page ===');
    await page.goto(`http://127.0.0.1:4175/projects/${projectId}/proofread`);
    await page.waitForTimeout(3000);

    console.log('Proofread URL:', page.url());

    // 分析页面
    const bodyText = await page.locator('body').textContent();
    console.log('\n=== Page Analysis ===');
    console.log('Contains "文字校对":', bodyText.includes('文字校对'));
    console.log('Contains "原始 PDF":', bodyText.includes('原始 PDF'));
    console.log('Contains "识别结果":', bodyText.includes('识别结果'));

    const iframeCount = await page.locator('iframe').count();
    const textareaCount = await page.locator('textarea').count();
    console.log('iframe count (PDF preview):', iframeCount);
    console.log('textarea count (edit area):', textareaCount);

    // 获取页数
    const pageMatch = bodyText.match(/共 (\d+) 页/);
    console.log('Total pages:', pageMatch ? pageMatch[1] : '0');

    // 截图
    try {
      await page.screenshot({ path: 'proofread-new-project.png', timeout: 5000 });
      console.log('Screenshot saved to proofread-new-project.png');
    } catch (e) {
      console.log('Screenshot timeout');
    }

    console.log('\nPage preview (first 500 chars):');
    console.log(bodyText.substring(0, 500));

    await browser.close();
    console.log('\n=== Test Completed ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

testCreateAndProofread();
