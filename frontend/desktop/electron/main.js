import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, net, protocol, safeStorage, screen, session, shell } from 'electron';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { closeBehaviors, normalizeCloseBehavior } from './preferences.js';
import { getDefaultWindowBounds, getRestorableWindowBounds } from './window-state.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.JOJO_DESKTOP_RENDERER_URL;
const testSelectedPdf = process.env.JOJO_PRESS_TEST_SELECTED_PDF;
const remoteDebuggingPort = process.env.JOJO_DESKTOP_REMOTE_DEBUGGING_PORT ?? process.env.JOJO_PRESS_REMOTE_DEBUGGING_PORT;
let mainWindow;
let tray;
let isQuitting = false;
let pendingCloseWindow;
let closeBehavior = 'ask';
let ragWorkspaceEnabled = false;
let engineWorker;
let nextEngineRequestId = 1;
const pendingEngineRequests = new Map();
const mineruSettingsPath = () => path.join(app.getPath('userData'), 'mineru-token.bin');
const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');
const preferencesPath = () => path.join(app.getPath('userData'), 'desktop-preferences.json');

app.setName('JOJO看报');

function isWindowBounds(value) {
  return value
    && Number.isInteger(value.x)
    && Number.isInteger(value.y)
    && Number.isInteger(value.width)
    && Number.isInteger(value.height)
    && value.width >= 1024
    && value.height >= 720;
}

function isVisibleOnCurrentDisplays(bounds) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapWidth = Math.max(0, Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x));
    const overlapHeight = Math.max(0, Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y));
    return overlapWidth >= 160 && overlapHeight >= 80;
  });
}

async function readWindowState() {
  try {
    const state = JSON.parse(await readFile(windowStatePath(), 'utf8'));
    if (!isWindowBounds(state.bounds) || !isVisibleOnCurrentDisplays(state.bounds)) return {};
    const maximized = state.maximized === true;
    const workArea = screen.getDisplayMatching(state.bounds).workArea;
    return {
      bounds: getRestorableWindowBounds(state.bounds, workArea, maximized),
      maximized,
    };
  } catch {
    return {};
  }
}

async function readCloseBehavior() {
  try {
    const preferences = JSON.parse(await readFile(preferencesPath(), 'utf8'));
    return normalizeCloseBehavior(preferences.closeBehavior);
  } catch {
    return 'ask';
  }
}

async function saveCloseBehavior(value) {
  const normalized = normalizeCloseBehavior(value);
  closeBehavior = normalized;
  await writeFile(preferencesPath(), JSON.stringify({ closeBehavior: normalized }));
  return normalized;
}

function attachWindowStatePersistence(window) {
  let saveTimer;
  const save = () => {
    if (window.isDestroyed()) return;
    const state = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized()
    };
    void writeFile(windowStatePath(), JSON.stringify(state)).catch(() => undefined);
  };
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  };
  window.on('move', scheduleSave);
  window.on('resize', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  window.on('close', () => {
    clearTimeout(saveTimer);
    save();
  });
}

function attachNativeContextMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    const template = params.isEditable
      ? [
          { role: 'undo', enabled: params.editFlags.canUndo },
          { role: 'redo', enabled: params.editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll }
        ]
      : params.selectionText
        ? [{ role: 'copy' }, { role: 'selectAll' }]
        : [];
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window });
  });
}

function showMainWindow() {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  if (tray) return;
  const trayIcon = nativeImage
    .createFromPath(path.join(currentDir, '../dist/brand/jojo-kanbao-mark.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('JOJO看报');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 JOJO看报', click: showMainWindow },
    { label: '设置', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
}

function attachCloseChoice(window) {
  window.on('close', (event) => {
    if (isQuitting) return;
    if (closeBehavior === 'quit') {
      isQuitting = true;
      return;
    }
    event.preventDefault();
    if (closeBehavior === 'tray') {
      window.hide();
      return;
    }
    if (pendingCloseWindow === window) return;
    pendingCloseWindow = window;
    window.webContents.send('jojo-desktop:request-close-choice');
  });
}

ipcMain.on('jojo-desktop:close-choice', async (event, choice) => {
  const window = pendingCloseWindow;
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
  if (!['tray', 'quit', 'cancel'].includes(choice)) return;
  pendingCloseWindow = undefined;
  if (choice === 'cancel') return;
  await saveCloseBehavior(choice).catch(() => undefined);
  if (choice === 'tray') {
    window.hide();
  } else if (choice === 'quit') {
    isQuitting = true;
    app.quit();
  }
});

async function readMineruToken() {
  try {
    const encrypted = await readFile(mineruSettingsPath());
    return safeStorage.decryptString(encrypted);
  } catch {
    return '';
  }
}

async function saveMineruToken(token) {
  const normalized = String(token ?? '').trim();
  if (normalized.length > 4096) throw new Error('MinerU API Key 长度无效');
  if (!normalized) {
    await unlink(mineruSettingsPath()).catch(() => undefined);
    return '';
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法安全保存 MinerU API Key');
  }
  await writeFile(mineruSettingsPath(), safeStorage.encryptString(normalized));
  return normalized;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'jojo-pdf',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

if (remoteDebuggingPort) app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort);

function navigateTo(pathname) {
  mainWindow?.webContents.send('jojo-desktop:navigate', pathname);
}

function openSettings() {
  showMainWindow();
  navigateTo('/settings');
}

function setupApplicationMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: '前往',
      submenu: [
        { label: '今日阅读', accelerator: 'CmdOrCtrl+1', click: () => navigateTo('/') },
        { label: '资料库', accelerator: 'CmdOrCtrl+2', click: () => navigateTo('/library') },
        { label: '搜索', accelerator: 'CmdOrCtrl+3', click: () => navigateTo('/search') },
        ...(ragWorkspaceEnabled
          ? [{ label: 'JOJO 问答', accelerator: 'CmdOrCtrl+4', click: () => navigateTo('/rag') }]
          : [])
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }])
      ]
    },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'togglefullscreen' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const savedState = await readWindowState();
  const initialBounds = savedState.bounds ?? getDefaultWindowBounds(screen.getPrimaryDisplay().workArea);
  const window = new BrowserWindow({
    ...initialBounds,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    title: 'JOJO看报',
    backgroundColor: '#f4f4f2',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: {
        color: '#ffffff',
        symbolColor: '#202020',
        height: 64
      }
    }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = window;
  window.setMenuBarVisibility(false);
  attachWindowStatePersistence(window);
  attachNativeContextMenu(window);
  attachCloseChoice(window);
  window.once('ready-to-show', () => {
    if (savedState.maximized) window.maximize();
    window.show();
  });
  window.on('closed', () => {
    if (pendingCloseWindow === window) pendingCloseWindow = undefined;
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('mailto:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowedOrigin = rendererUrl ? new URL(rendererUrl).origin : 'file://';
    const targetOrigin = new URL(url).origin;
    if (targetOrigin === allowedOrigin || (allowedOrigin === 'file://' && url.startsWith('file://'))) return;
    event.preventDefault();
    if (url.startsWith('https://') || url.startsWith('mailto:')) void shell.openExternal(url);
  });

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(path.join(currentDir, '../dist/index.html'));
  }

}

ipcMain.handle('jojo-desktop:select-pdf', async () => {
  if (testSelectedPdf) {
    return testSelectedPdf;
  }

  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('jojo-desktop:app-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch
}));

ipcMain.handle('jojo-settings:close-behavior:get', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('unauthorized');
  return closeBehavior;
});

ipcMain.handle('jojo-settings:close-behavior:save', async (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('unauthorized');
  if (!closeBehaviors.includes(value)) throw new Error('关闭行为设置无效');
  return saveCloseBehavior(value);
});

ipcMain.handle('jojo-settings:launch-at-login:get', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('unauthorized');
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('jojo-settings:launch-at-login:save', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('unauthorized');
  if (typeof value !== 'boolean') throw new Error('开机启动设置无效');
  app.setLoginItemSettings({ openAtLogin: value });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('jojo-desktop:feature-availability', (event, features) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const nextRagWorkspaceEnabled = features?.rag === true;
  if (ragWorkspaceEnabled === nextRagWorkspaceEnabled) return;
  ragWorkspaceEnabled = nextRagWorkspaceEnabled;
  setupApplicationMenu();
});

async function startEngineApplication() {
  const runtimeRoot = path.join(app.getPath('userData'), 'press');
  process.env.JOJO_PRESS_PROJECTS_ROOT = path.join(runtimeRoot, 'projects');
  process.env.JOJO_PRESS_EXPORT_ROOT = path.join(runtimeRoot, 'exports');
  engineWorker = new Worker(new URL('../dist/engine/worker.js', import.meta.url));
  engineWorker.on('message', (message) => {
    const pending = pendingEngineRequests.get(message.id);
    if (!pending) return;
    pendingEngineRequests.delete(message.id);
    pending.resolve(message);
  });
  engineWorker.on('error', (error) => {
    for (const pending of pendingEngineRequests.values()) pending.reject(error);
    pendingEngineRequests.clear();
  });
  const invokeEngine = (command, payload = {}) => new Promise((resolve, reject) => {
    const id = nextEngineRequestId++;
    pendingEngineRequests.set(id, { resolve, reject });
    engineWorker.postMessage({ id, command, payload });
  });
  await invokeEngine('settings:mineru:configure', { token: await readMineruToken() });

  ipcMain.handle('jojo-settings:mineru:get', async () => ({
    configured: Boolean(await readMineruToken())
  }));
  ipcMain.handle('jojo-settings:mineru:save', async (_event, token) => {
    const savedToken = await saveMineruToken(token);
    await invokeEngine('settings:mineru:configure', { token: savedToken });
    return { configured: Boolean(savedToken) };
  });
  const commands = new Set([
    'health',
    'projects:list',
    'projects:get',
    'projects:create',
    'projects:metadata:get',
    'projects:metadata:save',
    'projects:source:import',
    'recognition:start',
    'recognition:status',
    'proofread:workspace',
    'proofread:block:save',
    'quality:get',
    'export:options',
    'export:run'
  ]);
  ipcMain.handle('jojo-engine:invoke', async (_event, command, payload) => {
    if (!commands.has(command)) {
      return { ok: false, error: { status: 404, message: 'unknown engine command' } };
    }
    try {
      return await invokeEngine(command, payload && typeof payload === 'object' ? payload : {});
    } catch (error) {
      return {
        ok: false,
        error: {
          status: Number(error?.status ?? 500),
          message: error instanceof Error ? error.message : 'engine request failed'
        }
      };
    }
  });

  protocol.handle('jojo-pdf', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'project') return new Response('not found', { status: 404 });
    try {
      const result = await invokeEngine('projects:source:path', {
        projectId: decodeURIComponent(url.pathname.slice(1))
      });
      if (!result.ok) return new Response('not found', { status: result.error.status });
      const pdfPath = result.value;
      return net.fetch(pathToFileURL(pdfPath).href, {
        headers: request.headers
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    closeBehavior = await readCloseBehavior();
    setupApplicationMenu();
    setupTray();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  tray?.destroy();
  tray = undefined;
  void engineWorker?.terminate();
});
