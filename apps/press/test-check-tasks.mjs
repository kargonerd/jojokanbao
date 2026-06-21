import { chromium } from 'playwright';

async function testCheckTasks() {
  console.log('Checking tasks in memory...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    // 获取项目列表
    await page.goto('http://127.0.0.1:4175/');
    await page.waitForTimeout(2000);

    const pageContent = await page.content();
    const matches = [...pageContent.matchAll(/\/projects\/([a-zA-Z0-9_]+)/g)];
    const projectIds = [...new Set(matches.map(m => m[1]))];

    console.log('Found projects:', projectIds.length);
    console.log('Project IDs:', projectIds.slice(0, 5));

    // 检查第一个项目的状态
    if (projectIds.length > 0) {
      const projectId = projectIds[0];
      console.log('\n=== Checking project:', projectId, '===');

      await page.goto(`http://127.0.0.1:4175/projects/${projectId}`);
      await page.waitForTimeout(3000);

      const bodyText = await page.locator('body').textContent();
      console.log('Status:', bodyText.includes('识别完成') ? 'Completed' :
                   bodyText.includes('识别中') ? 'Processing' :
                   bodyText.includes('排队中') ? 'Queued' : 'Unknown');

      // 检查校对页面
      await page.goto(`http://127.0.0.1:4175/projects/${projectId}/proofread`);
      await page.waitForTimeout(3000);

      const proofreadText = await page.locator('body').textContent();
      const pageMatch = proofreadText.match(/共 (\d+) 页/);
      console.log('Total pages:', pageMatch ? pageMatch[1] : '0');
    }

    await browser.close();
    console.log('\n=== Check Completed ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

testCheckTasks();
