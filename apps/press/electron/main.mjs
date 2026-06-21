import { BrowserWindow, Menu, app, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.JOJO_PRESS_RENDERER_URL;
const testSelectedPdf = process.env.JOJO_PRESS_TEST_SELECTED_PDF;
const autoUploadTestEnabled = process.env.JOJO_PRESS_AUTO_UPLOAD_TEST === '1';
const remoteDebuggingPort = process.env.JOJO_PRESS_REMOTE_DEBUGGING_PORT ?? '9222';

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

  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        {
          label: '打开 PDF',
          click: () => {
            window.webContents.send('menu-open-pdf');
          }
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
      window.webContents.send('jojo-press:auto-upload-test');
    });
  }
}

ipcMain.handle('jojo-press:select-pdf', async () => {
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

app.whenReady().then(() => {
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
