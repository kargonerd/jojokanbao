// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { fetchProjectOverview } from '../lib/api';
import ProjectOverviewPage from './ProjectOverviewPage';

afterEach(() => {
  cleanup();
});

describe('ProjectOverviewPage', () => {
  it('shows one primary next-step action from engine-backed overview data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'project-demo',
        title: '革命造反年代',
        currentStage: 'Metadata confirmation'
      })
    } as Response);
    const router = createMemoryRouter(
      [
        {
          path: '/projects/:projectId',
          element: <ProjectOverviewPage />,
          loader: ({ params }) => {
            if (!params.projectId) {
              throw new Error('projectId is required');
            }

            return fetchProjectOverview(params.projectId);
          }
        }
      ],
      { initialEntries: ['/projects/project-demo'] }
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByText('当前步骤')).toBeInTheDocument();
    expect(screen.getByText('请先检查书名、作者、语言和封面信息，确认无误后再进入校对。')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '项目导航' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '项目列表' })).toHaveAttribute('href', '/?variant=a');
    expect(screen.getByRole('link', { name: '检查识别结果' })).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(6);
    expect(screen.queryByText('Open Raw JSON')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects/project-demo', { method: 'GET' });
    });
  });

  it('loads overview data from the active project route param through the route loader', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'project-ops-handbook',
        title: '工作手册',
        currentStage: 'Proofreading workspace'
      })
    } as Response);
    const router = createMemoryRouter(
      [
        {
          path: '/projects/:projectId',
          element: <ProjectOverviewPage />,
          loader: ({ params }) => {
            if (!params.projectId) {
              throw new Error('projectId is required');
            }

            return fetchProjectOverview(params.projectId);
          }
        }
      ],
      { initialEntries: ['/projects/project-ops-handbook'] }
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '工作手册' })).toBeInTheDocument();
    expect(screen.getByText('请对照扫描页检查识别文字，修改后保存。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '继续校对' })).toHaveAttribute(
      'href',
      '/projects/project-ops-handbook/proofread'
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects/project-ops-handbook', { method: 'GET' });
    });
  });
});
