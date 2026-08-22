// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
const send = vi.fn();

afterEach(() => {
  exposeInMainWorld.mockReset();
  invoke.mockReset();
  on.mockReset();
  removeListener.mockReset();
  send.mockReset();
});

describe('preload bridge', () => {
  it('exposes only the active desktop shell bridge from the CommonJS preload entry', () => {
    const preloadSource = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
    const localRequire = (specifier: string) => {
      if (specifier === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld
          },
          ipcRenderer: {
            invoke,
            on,
            removeListener,
            send,
          }
        };
      }

      throw new Error(`Unexpected require: ${specifier}`);
    };
    const module = { exports: {} };
    const executePreload = new Function('require', 'module', 'exports', preloadSource);

    executePreload(localRequire, module, module.exports);

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);

    const [bridgeName, exposedBridge] = exposeInMainWorld.mock.calls[0] as [
      string,
      {
        appName: string;
        platform: NodeJS.Platform;
        getAppInfo: () => Promise<unknown>;
        setFeatureAvailability: (features: { rag: boolean }) => void;
        onCloseChoiceRequested: (callback: () => void) => () => void;
        respondToCloseChoice: (choice: 'tray' | 'quit' | 'cancel') => void;
        settings: {
          getCloseBehavior: () => Promise<'ask' | 'tray' | 'quit'>;
          saveCloseBehavior: (behavior: 'ask' | 'tray' | 'quit') => Promise<'ask' | 'tray' | 'quit'>;
          getLaunchAtLogin: () => Promise<boolean>;
          saveLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
        };
        selectPdf?: unknown;
        engine?: unknown;
      }
    ];

    expect(bridgeName).toBe('jojoDesktop');
    expect(exposedBridge.appName).toBe('jojo-desktop');
    expect(exposedBridge.platform).toBe(process.platform);
    expect(exposedBridge.selectPdf).toBeUndefined();
    expect(exposedBridge.engine).toBeUndefined();
    expect(exposedBridge.getAppInfo).toEqual(expect.any(Function));
    exposedBridge.setFeatureAvailability({ rag: false });
    expect(send).toHaveBeenCalledWith('jojo-desktop:feature-availability', { rag: false });

    expect(invoke).not.toHaveBeenCalledWith('jojo-desktop:select-pdf');
    expect(invoke).not.toHaveBeenCalledWith('jojo-engine:invoke', expect.anything(), expect.anything());
  });

  it('exposes close-choice events and the persisted close preference', async () => {
    const preloadSource = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
    const localRequire = () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener, send },
    });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', preloadSource)(localRequire, module, module.exports);
    const bridge = exposeInMainWorld.mock.calls[0]?.[1] as {
      onCloseChoiceRequested: (callback: () => void) => () => void;
      respondToCloseChoice: (choice: 'tray' | 'quit' | 'cancel') => void;
      settings: {
        getCloseBehavior: () => Promise<'ask' | 'tray' | 'quit'>;
        saveCloseBehavior: (behavior: 'ask' | 'tray' | 'quit') => Promise<'ask' | 'tray' | 'quit'>;
        getLaunchAtLogin: () => Promise<boolean>;
        saveLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
      };
    };
    const callback = vi.fn();

    const unsubscribe = bridge.onCloseChoiceRequested(callback);
    const listener = on.mock.calls.find(([channel]) => channel === 'jojo-desktop:request-close-choice')?.[1];
    listener?.({});
    expect(callback).toHaveBeenCalledOnce();

    bridge.respondToCloseChoice('tray');
    expect(send).toHaveBeenCalledWith('jojo-desktop:close-choice', 'tray');
    invoke.mockResolvedValueOnce('tray');
    await expect(bridge.settings.getCloseBehavior()).resolves.toBe('tray');
    expect(invoke).toHaveBeenCalledWith('jojo-settings:close-behavior:get');
    bridge.settings.saveCloseBehavior('ask');
    expect(invoke).toHaveBeenCalledWith('jojo-settings:close-behavior:save', 'ask');
    bridge.settings.getLaunchAtLogin();
    expect(invoke).toHaveBeenCalledWith('jojo-settings:launch-at-login:get');
    bridge.settings.saveLaunchAtLogin(true);
    expect(invoke).toHaveBeenCalledWith('jojo-settings:launch-at-login:save', true);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('jojo-desktop:request-close-choice', listener);
  });

  it('points the Electron main process at the CommonJS preload entry', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain("preload: path.join(currentDir, 'preload.cjs')");
    expect(mainSource).toContain("loadFile(path.join(currentDir, '../dist/index.html'))");
  });

  it('does not initialize the disabled Press engine or its privileged PDF scheme', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).not.toContain('new Worker(');
    expect(mainSource).not.toContain("ipcMain.handle('jojo-engine:invoke'");
    expect(mainSource).not.toContain('protocol.registerSchemesAsPrivileged');
    expect(mainSource).not.toContain("ipcMain.handle('jojo-desktop:select-pdf'");
  });

  it('does not expose a startup shortcut into the disabled Press flow', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).not.toContain('JOJO_PRESS_AUTO_UPLOAD_TEST');
    expect(mainSource).not.toContain("navigateTo('/press");
    expect(mainSource).not.toContain("navigateTo('/times");
  });

  it('only enables a remote debugging port when test configuration explicitly requests one', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain('process.env.JOJO_DESKTOP_REMOTE_DEBUGGING_PORT');
    expect(mainSource).not.toContain('JOJO_PRESS_REMOTE_DEBUGGING_PORT');
    expect(mainSource).toContain("if (remoteDebuggingPort) app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)");
    expect(mainSource).not.toContain("?? '9222'");
  });

  it('keeps the renderer sandboxed and denies permission prompts by default', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
    expect(mainSource).toContain('sandbox: true');
    expect(mainSource).toContain('setPermissionRequestHandler');
  });

  it('uses native window controls without a permanently visible menu bar', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain("titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden'");
    expect(mainSource).toContain('titleBarOverlay: {');
    expect(mainSource).toContain('autoHideMenuBar: true');
    expect(mainSource).toContain('window.setMenuBarVisibility(false)');
    expect(mainSource).toContain("window.webContents.on('context-menu'");
    expect(mainSource).toContain('window.getNormalBounds()');
  });

  it('asks once, persists the choice, and then applies it directly', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain('new Tray(trayIcon)');
    expect(mainSource).toContain("tray.setToolTip('JOJO看报')");
    expect(mainSource).toContain("webContents.send('jojo-desktop:request-close-choice')");
    expect(mainSource).toContain("ipcMain.on('jojo-desktop:close-choice'");
    expect(mainSource).toContain("preferencesPath(), JSON.stringify({ closeBehavior: normalized })");
    expect(mainSource).toContain("if (closeBehavior === 'tray')");
    expect(mainSource).toContain("if (closeBehavior === 'quit')");
    expect(mainSource).toContain("ipcMain.handle('jojo-settings:close-behavior:save'");
    expect(mainSource).toContain('window.hide()');
    expect(mainSource).toContain("{ label: '打开 JOJO看报', click: showMainWindow }");
    expect(mainSource).toContain("{ label: '退出', click: () => app.quit() }");
    expect(mainSource).not.toContain('dialog.showMessageBox(window');
  });

  it('keeps native navigation and startup settings synchronized with the renderer', () => {
    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');

    expect(mainSource).toContain("navigateTo('/search')");
    expect(mainSource).toContain("ipcMain.on('jojo-desktop:feature-availability'");
    expect(mainSource).toContain('...(ragWorkspaceEnabled');
    expect(mainSource).toContain("ipcMain.handle('jojo-settings:launch-at-login:get'");
    expect(mainSource).toContain("ipcMain.handle('jojo-settings:launch-at-login:save'");
    expect(mainSource).toContain('app.setLoginItemSettings({ openAtLogin: value })');
  });
});
