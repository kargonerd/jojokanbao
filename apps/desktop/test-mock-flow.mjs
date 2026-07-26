import { chromium } from 'playwright';

const BASE_URL = process.env.MOCK_FLOW_BASE_URL ?? 'http://127.0.0.1:4173';

const VARIANTS = [
  {
    id: 'a',
    homeHeading: '书稿制作工作台',
    uploadHeading: '新建任务',
    proofreadHeading: '文字校对工作台',
    homePath: '/?variant=a'
  },
  {
    id: 'b',
    homeHeading: '文献整编台',
    uploadHeading: '新建整编任务',
    proofreadHeading: '文献校订台',
    homePath: '/?variant=b'
  },
  {
    id: 'c',
    homeHeading: 'OCR 校对控制台',
    uploadHeading: '新建 OCR 任务',
    proofreadHeading: 'OCR 校对控制台',
    homePath: '/?variant=c'
  }
];

async function visitAndAssert(page, path, expectedHeading) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: expectedHeading }).waitFor({ timeout: 10000 });
  console.log(`OK ${path} -> ${expectedHeading}`);
}

async function assertVariantHome(page, variant) {
  await visitAndAssert(page, variant.homePath, variant.homeHeading);
  await page.getByRole('heading', { name: variant.uploadHeading }).waitFor({ timeout: 10000 });

  const choosePdfLink = page.getByRole('link', { name: '选择 PDF 文件' });
  await choosePdfLink.waitFor({ timeout: 10000 });
  const href = await choosePdfLink.getAttribute('href');
  if (href !== `/projects/mock-1/recognition?variant=${variant.id}`) {
    throw new Error(`Expected variant ${variant.id} home link to preserve query, got ${href}`);
  }

  const bodyVariant = await page.locator('body').getAttribute('data-mock-variant');
  if (bodyVariant !== variant.id) {
    throw new Error(`Expected body data-mock-variant=${variant.id}, got ${bodyVariant}`);
  }

  console.log(`OK variant ${variant.id} home query + theme`);
}

async function assertVariantProofread(page, variant) {
  await visitAndAssert(page, `/projects/mock-1/proofread?variant=${variant.id}`, variant.proofreadHeading);
  const bodyVariant = await page.locator('body').getAttribute('data-mock-variant');
  if (bodyVariant !== variant.id) {
    throw new Error(`Expected proofread body data-mock-variant=${variant.id}, got ${bodyVariant}`);
  }

  console.log(`OK variant ${variant.id} proofread deep link`);
}

async function assertVariantNavigation(page, variant) {
  await page.goto(`${BASE_URL}${variant.homePath}`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: '选择 PDF 文件' }).click();
  await page.getByRole('heading', { name: '识别进行中' }).waitFor({ timeout: 10000 });

  const bodyVariant = await page.locator('body').getAttribute('data-mock-variant');
  if (bodyVariant !== variant.id) {
    throw new Error(`Expected recognition body data-mock-variant=${variant.id}, got ${bodyVariant}`);
  }

  console.log(`OK variant ${variant.id} navigation flow`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  for (const variant of VARIANTS) {
    await assertVariantHome(page, variant);
    await assertVariantNavigation(page, variant);
    await assertVariantProofread(page, variant);
  }

  await visitAndAssert(page, '/projects/mock-1/metadata?variant=a', '确认书籍信息');
  await visitAndAssert(page, '/projects/mock-1/structured?variant=b', '结构化结果');
  await visitAndAssert(page, '/projects/mock-1/export?variant=c', '导出 EPUB');

  await page.goto(`${BASE_URL}/projects/mock-1/proofread?variant=c`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'mock-proofread-review.png', fullPage: true });
  console.log('Saved screenshot mock-proofread-review.png');

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
