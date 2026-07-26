import { chromium } from 'playwright';

async function testProofreadPage() {
  console.log('Testing proofread page...\n');

  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0];

    // 1. 先获取项目列表
    console.log('=== Step 1: Get Project List ===');
    await page.goto('http://127.0.0.1:4173/');
    await page.waitForTimeout(2000);

    const bodyText = await page.locator('body').textContent();
    console.log('Page loaded, has projects:', !bodyText.includes('还没有项目'));

    // 从页面中提取项目ID
    const pageContent = await page.content();
    const projectIdMatch = pageContent.match(/\/projects\/([a-zA-Z0-9_]+)/);
    let projectId = projectIdMatch ? projectIdMatch[1] : null;
    console.log('Found project ID:', projectId);

    if (!projectId) {
      console.log('No project found');
      await browser.close();
      return;
    }

    // 2. 直接导航到校对页面测试
    console.log('\n=== Step 2: Navigate to Proofread Page ===');
    await page.goto(`http://127.0.0.1:4173/projects/${projectId}/proofread`);
    await page.waitForTimeout(3000);

    console.log('Proofread page URL:', page.url());

    // 截图（使用较短的超时）
    try {
      await page.screenshot({ path: 'proofread-test-result.png', timeout: 5000 });
      console.log('Screenshot saved to proofread-test-result.png');
    } catch (e) {
      console.log('Screenshot timeout, but continuing...');
    }

    // 分析页面内容
    const proofreadBody = await page.locator('body').textContent();
    console.log('\n=== Page Content Analysis ===');
    console.log('Contains "文字校对":', proofreadBody.includes('文字校对'));
    console.log('Contains "原始 PDF":', proofreadBody.includes('原始 PDF'));
    console.log('Contains "识别结果":', proofreadBody.includes('识别结果'));
    console.log('Contains "保存修改":', proofreadBody.includes('保存修改'));
    console.log('Contains "上一页":', proofreadBody.includes('上一页'));
    console.log('Contains "下一页":', proofreadBody.includes('下一页'));

    // 检查是否有 iframe（PDF预览）
    const iframeCount = await page.locator('iframe').count();
    console.log('Number of iframes (PDF preview):', iframeCount);

    // 检查是否有 textarea（编辑区域）
    const textareaCount = await page.locator('textarea').count();
    console.log('Number of textareas (edit area):', textareaCount);

    // 获取页面文本预览
    console.log('\n=== Page text preview (first 800 chars) ===');
    console.log(proofreadBody.substring(0, 800));

    await browser.close();
    console.log('\n=== Test Completed ===');
  } catch (error) {
    console.error('Error:', error);
  }
}

testProofreadPage();
