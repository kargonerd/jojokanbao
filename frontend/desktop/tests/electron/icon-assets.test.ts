// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function iconSizes(icon: Buffer): number[] {
  expect(icon.readUInt16LE(0)).toBe(0);
  expect(icon.readUInt16LE(2)).toBe(1);
  const count = icon.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const width = icon.readUInt8(6 + index * 16);
    const height = icon.readUInt8(7 + index * 16);
    expect(height || 256).toBe(width || 256);
    return width || 256;
  });
}

describe('desktop icon assets', () => {
  it('ships a multi-resolution Windows icon for the window, taskbar, tray, and package', () => {
    const icon = readFileSync(new URL('../../electron/assets/icon.ico', import.meta.url));
    expect(iconSizes(icon)).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);

    const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
    expect(mainSource).toContain("app.setAppUserModelId('cn.jojokanbao.desktop')");
    expect(mainSource).toContain('icon: appIconPath');
    expect(mainSource).not.toContain('.resize({ width: 16, height: 16 });');

    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      build: { win: { icon: string } };
    };
    expect(packageJson.build.win.icon).toBe('electron/assets/icon.ico');
  });
});
