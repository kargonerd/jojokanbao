import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from './SettingsPage';

const getCloseBehavior = vi.fn();
const saveCloseBehavior = vi.fn();
const getLaunchAtLogin = vi.fn();
const saveLaunchAtLogin = vi.fn();
const getAppInfo = vi.fn();
const getUpdateState = vi.fn();
const checkForUpdates = vi.fn();
const installUpdate = vi.fn();

afterEach(cleanup);

beforeEach(() => {
  getCloseBehavior.mockReset().mockResolvedValue('tray');
  saveCloseBehavior.mockReset().mockImplementation(async (value) => value);
  getLaunchAtLogin.mockReset().mockResolvedValue(false);
  saveLaunchAtLogin.mockReset().mockImplementation(async (value) => value);
  getAppInfo.mockReset().mockResolvedValue({ version: '0.0.1', platform: 'win32', arch: 'x64' });
  getUpdateState.mockReset().mockResolvedValue({
    supported: true,
    phase: 'not-available',
    currentVersion: '0.0.1',
    message: '当前已是最新版本。',
  });
  checkForUpdates.mockReset().mockResolvedValue({ supported: true, phase: 'checking', currentVersion: '0.0.1', message: '正在检查新版本…' });
  installUpdate.mockReset().mockResolvedValue(undefined);
  window.jojoDesktop = {
    appName: 'test',
    platform: 'win32',
    settings: {
      getCloseBehavior,
      saveCloseBehavior,
      getLaunchAtLogin,
      saveLaunchAtLogin,
    },
    updates: {
      getState: getUpdateState,
      check: checkForUpdates,
      install: installUpdate,
      onState: () => () => undefined,
    },
    getAppInfo,
  };
});

describe('Desktop settings', () => {
  it('loads and updates the persisted close behavior', async () => {
    render(<SettingsPage />);

    const closeBehavior = await screen.findByRole('combobox', { name: '关闭窗口时' });
    expect(closeBehavior).toHaveValue('tray');
    fireEvent.change(closeBehavior, { target: { value: 'quit' } });
    await waitFor(() => expect(saveCloseBehavior).toHaveBeenCalledWith('quit'));
    expect(screen.getByText('已保存')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('版本 0.0.1');
  });

  it('lets the user restore first-close prompting', async () => {
    render(<SettingsPage />);

    const closeBehavior = await screen.findByRole('combobox', { name: '关闭窗口时' });
    fireEvent.change(closeBehavior, { target: { value: 'ask' } });
    await waitFor(() => expect(saveCloseBehavior).toHaveBeenCalledWith('ask'));
  });

  it('uses the native launch-at-login preference', async () => {
    render(<SettingsPage />);

    const launchAtLogin = await screen.findByRole('checkbox', { name: '开机时启动' });
    expect(launchAtLogin).not.toBeChecked();
    fireEvent.click(launchAtLogin);
    await waitFor(() => expect(saveLaunchAtLogin).toHaveBeenCalledWith(true));
    expect(launchAtLogin).toBeChecked();
  });

  it('hides unsupported launch-at-login settings on Linux', async () => {
    window.jojoDesktop = { ...window.jojoDesktop!, platform: 'linux' };

    render(<SettingsPage />);

    await screen.findByRole('combobox', { name: '关闭窗口时' });
    expect(screen.queryByRole('checkbox', { name: '开机时启动' })).not.toBeInTheDocument();
    expect(getLaunchAtLogin).not.toHaveBeenCalled();
  });

  it('checks for application updates from settings', async () => {
    render(<SettingsPage />);

    const check = await screen.findByRole('button', { name: '检查更新' });
    fireEvent.click(check);
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledOnce());
    expect(screen.getByText('当前已是最新版本。')).toBeInTheDocument();
  });
});
