import { chromium } from 'playwright';

async function testGetProjectId() {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    await page.goto('http://127.0.0.1:4174/');
    await page.waitForTimeout(2000);

    const pageContent = await page.content();
    const matches = pageContent.match(/\/projects\/([a-zA-Z0-9_]+)/g);

    console.log('Found project URLs:');
    if (matches) {
      matches.forEach(url => console.log(url));
    } else {
      console.log('No projects found');
    }

    // 获取第一个项目的ID
    const projectIdMatch = pageContent.match(/\/projects\/([a-zA-Z0-9_]+)/);
    const projectId = projectIdMatch ? projectIdMatch[1] : null;
    console.log('\nFirst project ID:', projectId);

    await browser.close();
  } catch (error) {
    console.error('Error:', error);
  }
}

testGetProjectId();
