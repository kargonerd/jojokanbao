import { app, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
const initialCheckDelay = 15_000;
const checkInterval = 6 * 60 * 60 * 1_000;

let state = {
  supported: false,
  phase: 'idle',
  currentVersion: '',
  message: '自动更新只在正式安装版本中启用。',
};
let getMainWindow = () => undefined;
let beforeInstall = () => undefined;
let checkTimer;
let intervalTimer;
let handlersRegistered = false;
let eventsRegistered = false;

function updaterSupported() {
  return app.isPackaged && (process.platform !== 'linux' || Boolean(process.env.APPIMAGE));
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return message.replace(/([A-Za-z]:)?[\\/][^\s]+/g, '[本机路径]').slice(0, 240);
}

function publish(patch) {
  state = { ...state, ...patch };
  const window = getMainWindow();
  if (window && !window.isDestroyed()) window.webContents.send('jojo-updater:state', state);
  return state;
}

async function checkForUpdates(manual = false) {
  if (!updaterSupported()) {
    return publish({
      supported: false,
      phase: 'idle',
      message: manual && app.isPackaged
        ? 'Linux DEB 请从官网下载新安装包；AppImage 支持应用内更新。'
        : manual ? '开发预览不连接正式更新通道。' : state.message,
    });
  }
  if (state.phase === 'checking' || state.phase === 'downloading') return state;
  publish({ supported: true, phase: 'checking', message: '正在检查新版本…' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publish({ supported: true, phase: 'error', message: `检查失败：${publicError(error)}` });
  }
  return state;
}

function registerUpdaterEvents() {
  if (eventsRegistered) return;
  eventsRegistered = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => {
    publish({ supported: true, phase: 'checking', message: '正在检查新版本…' });
  });
  autoUpdater.on('update-available', (info) => {
    publish({ supported: true, phase: 'available', availableVersion: info.version, message: `发现 ${info.version}，准备下载…` });
  });
  autoUpdater.on('download-progress', (progress) => {
    publish({
      supported: true,
      phase: 'downloading',
      progress: Math.max(0, Math.min(100, Math.round(progress.percent))),
      message: `正在下载 ${Math.round(progress.percent)}%`,
    });
  });
  autoUpdater.on('update-not-available', () => {
    publish({ supported: true, phase: 'not-available', progress: undefined, message: '当前已是最新版本。', checkedAt: new Date().toISOString() });
  });
  autoUpdater.on('update-downloaded', (info) => {
    publish({
      supported: true,
      phase: 'downloaded',
      progress: 100,
      availableVersion: info.version,
      message: `${info.version} 已下载，重启后完成安装。`,
      checkedAt: new Date().toISOString(),
    });
  });
  autoUpdater.on('error', (error) => {
    publish({ supported: true, phase: 'error', message: `更新失败：${publicError(error)}` });
  });
}

function registerUpdaterIpc() {
  if (handlersRegistered) return;
  handlersRegistered = true;
  const authorize = (event) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('unauthorized');
  };
  ipcMain.handle('jojo-updater:state:get', (event) => {
    authorize(event);
    return state;
  });
  ipcMain.handle('jojo-updater:check', async (event) => {
    authorize(event);
    return checkForUpdates(true);
  });
  ipcMain.handle('jojo-updater:install', (event) => {
    authorize(event);
    if (state.phase !== 'downloaded') throw new Error('update-not-downloaded');
    beforeInstall();
    autoUpdater.quitAndInstall(false, true);
  });
}

export function setupDesktopUpdater(options) {
  getMainWindow = options.getMainWindow;
  beforeInstall = options.beforeInstall;
  state = {
    ...state,
    supported: updaterSupported(),
    currentVersion: app.getVersion(),
    message: updaterSupported()
      ? '将在后台定期检查更新。'
      : app.isPackaged ? 'Linux DEB 请从官网下载更新。' : state.message,
  };
  registerUpdaterIpc();
  if (!updaterSupported()) return;
  registerUpdaterEvents();
  checkTimer = setTimeout(() => void checkForUpdates(), initialCheckDelay);
  intervalTimer = setInterval(() => void checkForUpdates(), checkInterval);
}

export function stopDesktopUpdater() {
  clearTimeout(checkTimer);
  clearInterval(intervalTimer);
}
