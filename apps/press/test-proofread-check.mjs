import { chromium } from 'playwright';

async function testProofreadCheck() {
  console.log('Testing proofread page...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    // 使用第一个项目ID
    const projectId = 'proj_1775919364894_2rxao';

    // 1. 先检查项目状态
    console.log('=== Step 1: Check Project Status ===');
    await page.goto(`http://127.0.0.1:4174/projects/${projectId}`);
    await page.waitForTimeout(3000);

    const projectText = await page.locator('body').textContent();
    console.log('Project status:', projectText.includes('识别完成') ? 'Completed' :
                 projectText.includes('识别中') ? 'Processing' :
                 projectText.includes('排队中') ? 'Queued' : 'Unknown');

    // 2. 如果识别完成，进入校对页面
    if (projectText.includes('识别完成')) {
      console.log('\n=== Step 2: Navigate to Proofread Page ===');

      // 点击查看识别结果
      const resultBtn = await page.locator('a:has-text("查看识别结果")');
      if (await resultBtn.count() > 0) {
        await resultBtn.click();
        await page.waitForTimeout(3000);

        // 确认元数据
        const confirmBtn = await page.locator('button:has-text("确认")');
        if (await confirmBtn.count() > 0) {
          await confirmBtn.click();
          await page.waitForTimeout(3000);
        }
      }

      // 导航到校对页面
      await page.goto(`http://127.0.0.1:4174/projects/${projectId}/proofread`);
      await page.waitForTimeout(3000);

      console.log('Proofread URL:', page.url());

      // 分析页面
      const proofreadText = await page.locator('body').textContent();
      console.log('\n=== Page Content Analysis ===');
      console.log('Contains "文字校对":', proofreadText.includes('文字校对'));
      console.log('Contains "原始 PDF":', proofreadText.includes('原始 PDF'));
      console.log('Contains "识别结果":', proofreadText.includes('识别结果'));
      console.log('Contains "保存修改":', proofreadText.includes('保存修改'));

      const iframeCount = await page.locator('iframe').count();
      const textareaCount = await page.locator('textarea').count();
      console.log('iframe count (PDF preview):', iframeCount);
      console.log('textarea count (edit area):', textareaCount);

      // 截图
      try {
        await page.screenshot({ path: 'proofread-check.png', timeout: 5000 });
        console.log('Screenshot saved to proofread-check.png');
      } catch (e) {
        console.log('Screenshot timeout');
      }

      // 获取页面文本预览
      console.log('\nPage text preview (first 600 chars):');
      console.log(proofreadText.substring(0, 600));
    } else {
      console.log('\nRecognition not completed yet, cannot test proofread page');
      console.log('Please wait for recognition to complete and try again');
    }

    await browser.close();
    console.log('\n=== Test Completed ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

testProofreadCheck();
