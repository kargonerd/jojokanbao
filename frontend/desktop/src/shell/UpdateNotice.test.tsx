import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateNotice } from './UpdateNotice';

const install = vi.fn();

afterEach(cleanup);

beforeEach(() => {
  install.mockReset().mockResolvedValue(undefined);
  window.jojoDesktop = {
    appName: 'test',
    updates: {
      getState: vi.fn().mockResolvedValue({
        supported: true,
        phase: 'downloaded',
        currentVersion: '1.0.0',
        availableVersion: '1.1.0',
        message: '已下载',
      }),
      check: vi.fn(),
      install,
      onState: () => () => undefined,
    },
  };
});

describe('UpdateNotice', () => {
  it('offers to restart after a desktop update has downloaded', async () => {
    render(<UpdateNotice />);
    fireEvent.click(await screen.findByRole('button', { name: '重启安装' }));
    await waitFor(() => expect(install).toHaveBeenCalledOnce());
  });

  it('can be dismissed for the downloaded version', async () => {
    render(<UpdateNotice />);
    fireEvent.click(await screen.findByRole('button', { name: '稍后' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
