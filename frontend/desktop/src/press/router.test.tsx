import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter, createPressRoute } from './router';

const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  window.jojoDesktop = {
    appName: 'jojo-desktop',
    selectPdf: vi.fn(),
    engine: { invoke },
  } as unknown as JojoDesktopBridge;
});

describe('Press routes', () => {
  it('mounts below the desktop /press route', () => {
    expect(createPressRoute().path).toBe('/press');
  });

  it('loads the project list through IPC', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'health') return { ok: true, value: { status: 'ok' } };
      if (command === 'projects:list') {
        return {
          ok: true,
          value: [{ id: 'p1', title: '测试书稿', currentStage: 'Recognition' }],
        };
      }
      return { ok: false, error: { status: 404, message: 'unknown' } };
    });

    render(<RouterProvider router={createAppRouter({ initialEntries: ['/press'] })} />);
    expect(await screen.findByText('测试书稿')).toBeInTheDocument();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('health', {});
      expect(invoke).toHaveBeenCalledWith('projects:list', {});
    });
  });

  it('shows an empty list when the engine is unavailable', async () => {
    invoke.mockResolvedValue({ ok: false, error: { status: 500, message: 'offline' } });
    render(<RouterProvider router={createAppRouter({ initialEntries: ['/press'] })} />);
    expect(await screen.findByText('还没有项目')).toBeInTheDocument();
  });
});
