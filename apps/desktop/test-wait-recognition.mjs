import { chromium } from 'playwright';

async function testWaitRecognition() {
  console.log('Waiting for recognition to complete...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    // 从之前的测试知道项目ID
    const projectId = 'proj_1775917849609_5b9oq'; // 根据实际项目ID调整

    // 导航到项目页面
    console.log('=== Monitoring Recognition Progress ===');
    await page.goto(`http://127.0.0.1:4174/projects/${projectId}`);

    let recognitionCompleted = false;
    let attempts = 0;
    const maxAttempts = 120; // 最多等待4分钟

    while (!recognitionCompleted && attempts < maxAttempts) {
      await page.reload();
      await page.waitForTimeout(2000);

      const pageText = await page.locator('body').textContent();

      if (pageText.includes('识别完成')) {
        console.log('\n✓ Recognition completed!');
        recognitionCompleted = true;

        // 点击查看识别结果
        const resultButton = await page.locator('a:has-text("查看识别结果")');
        if (await resultButton.count() > 0) {
          await resultButton.click();
          await page.waitForTimeout(3000);
          console.log('Navigated to metadata page');

          // 确认元数据
          const confirmBtn = await page.locator('button:has-text("确认")');
          if (await confirmBtn.count() > 0) {
            await confirmBtn.click();
            await page.waitForTimeout(3000);
            console.log('Confirmed metadata');
          }
        }

        // 导航到校对页面
        await page.goto(`http://127.0.0.1:4174/projects/${projectId}/proofread`);
        await page.waitForTimeout(3000);

        console.log('\n=== Proofread Page Analysis ===');
        console.log('URL:', page.url());

        const proofreadText = await page.locator('body').textContent();
        console.log('Contains "文字校对":', proofreadText.includes('文字校对'));
        console.log('Contains "原始 PDF":', proofreadText.includes('原始 PDF'));
        console.log('Contains "识别结果":', proofreadText.includes('识别结果'));

        const iframeCount = await page.locator('iframe').count();
        const textareaCount = await page.locator('textarea').count();
        console.log('iframe count (PDF):', iframeCount);
        console.log('textarea count (edit):', textareaCount);

        // 截图
        await page.screenshot({ path: 'proofread-final.png', timeout: 5000 });
        console.log('Screenshot saved to proofread-final.png');

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
    }

    await browser.close();
    console.log('\n=== Test Completed ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

testWaitRecognition();
