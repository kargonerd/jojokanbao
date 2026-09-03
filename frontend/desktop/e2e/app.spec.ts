import { test, expect } from '@playwright/test';

test.describe('Desktop renderer', () => {
  test('new-design reading workspace exposes the desktop modules', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: '今天读什么？' })).toBeVisible();
    const navigation = page.getByRole('navigation', { name: '主导航' });
    await expect(navigation.getByRole('link', { name: '资料库' })).toHaveAttribute('href', '/library');
    await expect(navigation.getByRole('link', { name: '搜索' })).toHaveAttribute('href', '/search');
    await expect(navigation.getByRole('link', { name: '关于' })).toHaveAttribute('href', '/support');
    await expect(navigation.getByRole('link', { name: 'AI' })).toHaveCount(0);
    await expect(navigation.getByRole('link', { name: '设置' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '设置' })).toHaveAttribute('href', '/settings');
    await expect(page.getByRole('link', { name: '设置' }).locator('svg')).toHaveAttribute('data-icon', 'adjustments');
    await expect(navigation.getByText(/Archive|Press|书刊制作|JOJO Times|时事/i)).toHaveCount(0);
  });

  test('About is the same shared Web page', async ({ page }) => {
    await page.goto('/support');

    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '关于' })).toHaveClass(/is-active/);
    await expect(page.getByRole('heading', { name: '关于 JOJO 看报' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '数据下载' })).toBeVisible();
  });

  test('account entry uses the same shared Web state', async ({ page }) => {
    await page.goto('/account');

    await expect(page.getByRole('heading', { name: '登录暂不可用' })).toBeVisible();
    await expect(page.getByRole('link', { name: /返回首页/ })).toHaveAttribute('href', '/');
  });

  test('shared library exposes the same periodicals and books as Web', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByRole('search').getByPlaceholder('搜索报刊或书名')).toBeVisible();
    await expect(page.getByRole('button', { name: '全部' })).toBeVisible();
    await expect(page.getByRole('button', { name: '书籍' })).toBeVisible();
    await expect(page.getByRole('button', { name: '报刊' })).toBeVisible();
    await expect(page.getByRole('link', { name: /人民日报/ })).toBeVisible();
  });

  test('gated modules and unknown routes provide a clear recovery path', async ({ page }) => {
    await page.goto('/press');
    await expect(page.getByRole('heading', { name: '没有找到这个页面' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '我的项目' })).toHaveCount(0);
    await page.goto('/rag');
    await expect(page).toHaveURL(/\/account\?returnTo=/);
    await expect(page.getByRole('heading', { name: '登录暂不可用' })).toBeVisible();
    await page.goto('/times');
    await expect(page).toHaveURL(/\/account\?returnTo=/);
    await expect(page.getByRole('heading', { name: '登录暂不可用' })).toBeVisible();
    await page.goto('/account/times-sources');
    await expect(page).toHaveURL(/\/account\?returnTo=/);
    await expect(page.getByRole('heading', { name: '登录暂不可用' })).toBeVisible();
    await page.goto('/notifications');
    await expect(page.getByRole('heading', { name: '登录后查看通知' })).toBeVisible();
  });

  test('search uses the shared Web search page', async ({ page }) => {
    await page.goto('/search');
    await expect(page.getByPlaceholder('在JOJO看报上搜索')).toBeVisible();
    await expect(page.locator('[data-search-scroll-container]')).toHaveCSS('background-color', 'rgb(244, 244, 242)');
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '搜索' })).toHaveClass(/is-active/);
  });

  test('settings uses a compact utility layout outside the main tabs', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: '设置' }).click();
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '关闭窗口时' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '开机时启动' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设置' })).toHaveCount(0);
    const firstRow = page.locator('.desktop-preference-row').first();
    expect((await firstRow.boundingBox())?.height).toBeLessThanOrEqual(72);
  });

  test('shared base styles keep the sticky title bar opaque and controls intentional', async ({ page }) => {
    await page.goto('/');
    const header = page.locator('.app-header');
    const searchButton = page.getByRole('button', { name: '搜索' });

    await expect(header).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(searchButton).toHaveCSS('background-color', 'rgb(139, 26, 26)');
    await expect(searchButton).toHaveCSS('color', 'rgb(245, 239, 230)');

    await page.evaluate(() => window.scrollTo(0, 240));
    const navigationOwnsItsPixels = await page.getByRole('navigation', { name: '主导航' }).evaluate((navigation) => {
      const bounds = navigation.getBoundingClientRect();
      const topElement = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return topElement === navigation || navigation.contains(topElement);
    });
    expect(navigationOwnsItsPixels).toBe(true);
  });

  test('RAG requires a signed-in account', async ({ page }) => {
    await page.goto('/rag/chat');
    await expect(page).toHaveURL(/\/account\?returnTo=/);
    await expect(page.getByRole('heading', { name: '登录暂不可用' })).toBeVisible();
    await expect(page.getByRole('region', { name: '提问范围' })).toHaveCount(0);
  });

  test('close choice is a simple one-time preference dialog', async ({ page }) => {
    await page.addInitScript(() => {
      let requestCloseChoice: (() => void) | undefined;
      Object.defineProperty(window, 'jojoDesktop', {
        configurable: true,
        value: {
          appName: 'jojo-desktop-e2e',
          platform: 'win32',
          engine: { invoke: async () => ({ ok: true, value: null }) },
          onCloseChoiceRequested: (callback: () => void) => {
            requestCloseChoice = callback;
            return () => { requestCloseChoice = undefined; };
          },
          respondToCloseChoice: (choice: string) => {
            (window as Window & { __closeChoice?: string }).__closeChoice = choice;
          },
        },
      });
      (window as Window & { __requestCloseChoice?: () => void }).__requestCloseChoice = () => requestCloseChoice?.();
    });
    await page.goto('/');
    await page.evaluate(() => (window as Window & { __requestCloseChoice?: () => void }).__requestCloseChoice?.());

    const dialog = page.getByRole('dialog', { name: '关闭窗口' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('border-radius', '0px');
    await expect(dialog.locator('.close-choice-spine')).toHaveCount(0);
    const trayRadio = page.getByRole('radio', { name: /最小化到系统托盘/ });
    await expect(trayRadio).toBeChecked();
    await expect(trayRadio).toHaveCSS('width', '16px');
    await expect(trayRadio).toHaveCSS('height', '16px');
    await expect(trayRadio).toHaveCSS('padding-left', '0px');
    await expect(trayRadio).toHaveCSS('border-left-width', '0px');
    await expect(trayRadio).toHaveCSS('appearance', 'auto');
    await page.getByRole('button', { name: '确认' }).click();
    await expect.poll(() => page.evaluate(() => (window as Window & { __closeChoice?: string }).__closeChoice)).toBe('tray');
  });
});
