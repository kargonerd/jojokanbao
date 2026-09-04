import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const updaterSource = readFileSync(resolve(process.cwd(), 'electron/updater.js'), 'utf8');
const mainSource = readFileSync(resolve(process.cwd(), 'electron/main.js'), 'utf8');

describe('desktop updater wiring', () => {
  it('keeps updates in the main process and verifies the renderer sender', () => {
    expect(updaterSource).toContain("from 'electron-updater'");
    expect(updaterSource).toContain("event.sender !== window.webContents");
    expect(updaterSource).toContain("autoUpdater.allowDowngrade = false");
    expect(updaterSource).toContain("autoUpdater.allowPrerelease = false");
    expect(updaterSource).toContain("process.platform !== 'linux' || Boolean(process.env.APPIMAGE)");
    expect(updaterSource).toContain("autoUpdater.quitAndInstall(false, true)");
  });

  it('starts only after Electron is ready and marks updater restarts as intentional quits', () => {
    expect(mainSource).toContain('setupDesktopUpdater({');
    expect(mainSource).toContain('beforeInstall: () => { isQuitting = true; }');
    expect(mainSource).toContain('stopDesktopUpdater();');
  });
});
