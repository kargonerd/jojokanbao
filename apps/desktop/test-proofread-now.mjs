import { chromium } from 'playwright';

async function testProofreadNow() {
  console.log('Testing proofread page...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    // 使用识别完成的项目ID
    const projectId = 'proj_1775915558344_wiijf';

    console.log('=== Testing Proofread Page ===');
    await page.goto(`http://127.0.0.1:4174/projects/${projectId}/proofread`);
    await page.waitForTimeout(3000);

    console.log('URL:', page.url());

    // 分析页面
    const bodyText = await page.locator('body').textContent();
    console.log('\n=== Page Content ===');
    console.log('Contains "文字校对":', bodyText.includes('文字校对'));
    console.log('Contains "原始 PDF":', bodyText.includes('原始 PDF'));
    console.log('Contains "识别结果":', bodyText.includes('识别结果'));
    console.log('Contains "共 0 页":', bodyText.includes('共 0 页'));

    // 获取页数
    const pageMatch = bodyText.match(/共 (\d+) 页/);
    console.log('Total pages:', pageMatch ? pageMatch[1] : '0');

    const iframeCount = await page.locator('iframe').count();
    const textareaCount = await page.locator('textarea').count();
    console.log('iframe count:', iframeCount);
    console.log('textarea count:', textareaCount);

    // 截图
    try {
      await page.screenshot({ path: 'proofread-now.png', timeout: 5000 });
      console.log('Screenshot saved to proofread-now.png');
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

testProofreadNow();
