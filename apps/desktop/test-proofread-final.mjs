import { chromium } from 'playwright';

async function testProofreadFinal() {
  console.log('Testing proofread page after fix...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    // 使用识别完成的项目ID
    const projectId = 'proj_1775919364894_2rxao';

    console.log('=== Testing Proofread Page ===');
    await page.goto(`http://127.0.0.1:4175/projects/${projectId}/proofread`);
    await page.waitForTimeout(3000);

    console.log('URL:', page.url());

    // 分析页面
    const bodyText = await page.locator('body').textContent();
    console.log('\n=== Page Content ===');
    console.log('Contains "文字校对":', bodyText.includes('文字校对'));
    console.log('Contains "原始 PDF":', bodyText.includes('原始 PDF'));
    console.log('Contains "识别结果":', bodyText.includes('识别结果'));

    const iframeCount = await page.locator('iframe').count();
    const textareaCount = await page.locator('textarea').count();
    console.log('iframe count (PDF preview):', iframeCount);
    console.log('textarea count (edit area):', textareaCount);

    // 截图
    try {
      await page.screenshot({ path: 'proofread-final-result.png', timeout: 5000 });
      console.log('Screenshot saved');
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

testProofreadFinal();
