import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

test.describe('Real Electron client', () => {
  test('starts the sandboxed client and navigates core desktop features', async () => {
    for (const asset of [
      'dist/assets/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
      'dist/assets/pdfjs/wasm/qcms_bg.wasm',
      'dist/assets/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    ]) {
      expect(existsSync(path.resolve(import.meta.dirname, '..', asset))).toBe(true);
    }

    const userDataDir = await mkdtemp(path.join(tmpdir(), 'jojo-desktop-e2e-'));
    let receivedGatewayRequest: { authorization?: string; body?: string } = {};
    const gatewayServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        receivedGatewayRequest = {
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.write('event: text_delta\ndata: {"delta":"桌面流式响应"}\n\n');
        response.end('event: done\ndata: {}\n\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      gatewayServer.once('error', reject);
      gatewayServer.listen(0, '127.0.0.1', resolve);
    });
    const gatewayPort = (gatewayServer.address() as AddressInfo).port;
    let application: ElectronApplication | undefined;
    try {
      application = await electron.launch({
        args: ['electron/main.js', `--user-data-dir=${userDataDir}`],
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          ...process.env,
          JOJO_DESKTOP_RENDERER_URL: '',
          JOJO_DESKTOP_READER_ORIGIN: `http://127.0.0.1:${gatewayPort}`,
        },
      });
      const page = await application.firstWindow();

      await expect.poll(() => page.evaluate(() => window.jojoDesktop?.appName), { timeout: 20_000 }).toBe('jojo-desktop');
      await expect(page.getByRole('heading', { name: '今天读什么？' })).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => page.url()).toMatch(/^file:/);
      await expect(page).toHaveTitle('JOJO看报');
      const nativeWindowState = await application.evaluate(({ BrowserWindow, screen }) => {
        const [window] = BrowserWindow.getAllWindows();
        const normalBounds = window.getNormalBounds();
        const workArea = screen.getDisplayMatching(normalBounds).workArea;
        return {
          autoHideMenuBar: window.isMenuBarAutoHide(),
          menuBarVisible: window.isMenuBarVisible(),
          title: window.getTitle(),
          hasRestoreMargin: normalBounds.width < workArea.width || normalBounds.height < workArea.height,
        };
      });
      expect(nativeWindowState).toEqual({
        autoHideMenuBar: true,
        menuBarVisible: false,
        title: 'JOJO看报',
        hasRestoreMargin: true,
      });

      const agentResponse = await page.evaluate(async () => {
        const response = await fetch('jojo-agent://reader/gateway/ask', {
          method: 'POST',
          headers: {
            authorization: 'Bearer desktop-test-token',
            'content-type': 'application/json',
            'makers-conversation-id': 'desktop-e2e',
          },
          body: JSON.stringify({ message: '测试桌面网关' }),
        });
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        };
      });
      expect(agentResponse.status).toBe(200);
      expect(agentResponse.contentType).toContain('text/event-stream');
      expect(agentResponse.body).toContain('桌面流式响应');
      expect(receivedGatewayRequest.authorization).toBe('Bearer desktop-test-token');
      expect(receivedGatewayRequest.body).toBe('{"message":"测试桌面网关"}');

      await page.evaluate(() => window.jojoDesktop?.setFeatureAvailability?.({ rag: true, times: true }));
      await expect.poll(() => application?.evaluate(({ Menu }) => {
        const navigationMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === '前往');
        return navigationMenu?.submenu?.items.map((item) => item.label) ?? [];
      })).toEqual(expect.arrayContaining(['AI（Beta）', '时事（Beta）']));

      const navigation = page.getByRole('navigation', { name: '主导航' });
      await expect(navigation.getByText(/Press|书刊制作|JOJO Times|时事/i)).toHaveCount(0);
      await expect(navigation.getByRole('link', { name: '搜索' })).toBeVisible();
      await expect(navigation.getByRole('link', { name: '关于' })).toBeVisible();
      await expect(navigation.getByRole('link', { name: 'AI' })).toHaveCount(0);
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '资料库' }).click();
      await expect(page.getByPlaceholder('搜索报刊或书名')).toBeVisible();
      await expect(page.getByRole('button', { name: '报刊' })).toBeVisible();
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '搜索' }).click();
      await expect(page.getByPlaceholder('在JOJO看报上搜索')).toBeVisible();
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '关于' }).click();
      await expect(page.getByRole('heading', { name: '关于 JOJO 看报' })).toBeVisible();

      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      await expect(page.getByRole('dialog', { name: '关闭窗口' })).toBeVisible();
      await page.getByRole('button', { name: '确认' }).click();
      await expect.poll(() => application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
      await expect(page.getByRole('dialog', { name: '关闭窗口' })).toHaveCount(0);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      await expect.poll(() => application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
      await expect(page.getByRole('dialog', { name: '关闭窗口' })).toHaveCount(0);
    } finally {
      await application?.close();
      await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});
