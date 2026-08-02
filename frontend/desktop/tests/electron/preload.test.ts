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
    const executePreload = new Function('require', 'module', 'exports', preloadSource);

    invoke.mockResolvedValue('file:///C:/books/demo.pdf');

    executePreload(localRequire, module, module.exports);

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);

    const [bridgeName, exposedBridge] = exposeInMainWorld.mock.calls[0] as [
      string,
      {
        appName: string;
        selectPdf: () => Promise<string | null>;
        engine: { invoke: (command: string, payload?: object) => Promise<unknown> };
      }
    ];

    expect(bridgeName).toBe('jojoDesktop');
    expect(exposedBridge.appName).toBe('jojo-desktop');
    expect(exposedBridge.selectPdf).toEqual(expect.any(Function));

    await expect(exposedBridge.selectPdf()).resolves.toBe('file:///C:/books/demo.pdf');
    expect(invoke).toHaveBeenCalledWith('jojo-desktop:select-pdf');
    await exposedBridge.engine.invoke('projects:list', {});
    expect(invoke).toHaveBeenCalledWith('jojo-engine:invoke', 'projects:list', {});
  });

  it('points the Electron main process at the CommonJS preload entry', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain("preload: path.join(currentDir, 'preload.cjs')");
  });

  it('starts the compiled TypeScript application over IPC without a loopback server', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain("app.getPath('userData')");
    expect(mainSource).toContain("new Worker(new URL('../dist/engine/worker.js'");
    expect(mainSource).toContain("ipcMain.handle('jojo-engine:invoke'");
    expect(mainSource).not.toContain('.listen(');
    expect(mainSource).not.toContain('JOJO_PRESS_API_BASE_URL');
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
