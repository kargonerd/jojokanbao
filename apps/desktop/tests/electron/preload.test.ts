// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();

afterEach(() => {
  exposeInMainWorld.mockReset();
  invoke.mockReset();
});

describe('preload bridge', () => {
  it('exposes a PDF picker bridge from the CommonJS preload entry', async () => {
    const preloadSource = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
    const processMock = {
      env: {
        JOJO_PRESS_API_BASE_URL: 'http://127.0.0.1:8766'
      }
    };
    const localRequire = (specifier: string) => {
      if (specifier === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld
          },
          ipcRenderer: {
            invoke
          }
        };
      }

      throw new Error(`Unexpected require: ${specifier}`);
    };
    const module = { exports: {} };
    const executePreload = new Function('require', 'module', 'exports', 'process', preloadSource);

    invoke.mockResolvedValue('file:///C:/books/demo.pdf');

    executePreload(localRequire, module, module.exports, processMock);

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);

    const [bridgeName, exposedBridge] = exposeInMainWorld.mock.calls[0] as [
      string,
      { appName: string; apiBaseUrl?: string; selectPdf: () => Promise<string | null> }
    ];

    expect(bridgeName).toBe('jojoPress');
    expect(exposedBridge.appName).toBe('jojo-press');
    expect(exposedBridge.apiBaseUrl).toBe('http://127.0.0.1:8766');
    expect(exposedBridge.selectPdf).toEqual(expect.any(Function));

    await expect(exposedBridge.selectPdf()).resolves.toBe('file:///C:/books/demo.pdf');
    expect(invoke).toHaveBeenCalledWith('jojo-press:select-pdf');
  });

  it('points the Electron main process at the CommonJS preload entry', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain("preload: path.join(currentDir, 'preload.cjs')");
  });

  it('supports a configured test PDF path for automated upload verification', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain('process.env.JOJO_PRESS_TEST_SELECTED_PDF');
  });

  it('supports automatically triggering the upload flow for verification', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain("process.env.JOJO_PRESS_AUTO_UPLOAD_TEST === '1'");
  });

  it('enables a configurable Electron remote debugging port so end-to-end verification can attach to the real app window', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain("const remoteDebuggingPort = process.env.JOJO_PRESS_REMOTE_DEBUGGING_PORT ?? '9222'");
    expect(mainSource).toContain("app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)");
  });
});
