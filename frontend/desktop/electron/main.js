import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, safeStorage, shell } from 'electron';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.JOJO_DESKTOP_RENDERER_URL;
const testSelectedPdf = process.env.JOJO_PRESS_TEST_SELECTED_PDF;
const autoUploadTestEnabled = process.env.JOJO_PRESS_AUTO_UPLOAD_TEST === '1';
const remoteDebuggingPort = process.env.JOJO_PRESS_REMOTE_DEBUGGING_PORT ?? '9222';
let engineWorker;
let nextEngineRequestId = 1;
const pendingEngineRequests = new Map();
const mineruSettingsPath = () => path.join(app.getPath('userData'), 'mineru-token.bin');

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

app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort);

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(currentDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://mineru.net/')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        {
          label: '打开 PDF',
          click: () => {
            window.webContents.send('jojo-desktop:navigate', '/press/projects/new');
          }
        },
        { type: 'separator' },
        {
          label: '设置',
          click: () => window.webContents.send('jojo-desktop:navigate', '/settings')
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(path.join(currentDir, '../index.html'));
  }

  if (autoUploadTestEnabled) {
    window.webContents.once('did-finish-load', () => {
      window.webContents.send('jojo-desktop:navigate', '/press/projects/new');
    });
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
      return await invokeEngine(command, payload);
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

app.whenReady().then(async () => {
  await startEngineApplication();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void engineWorker?.terminate();
});
