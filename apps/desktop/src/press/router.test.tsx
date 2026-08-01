// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from './router';

const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      getPage: async () => ({
        getViewport: () => ({ width: 120, height: 160 }),
        render: () => ({ promise: Promise.resolve() })
      })
    })
  })
}));

vi.mock('pdfjs-dist', () => pdfjsMock);
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdfjsMock);

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    canvas: document.createElement('canvas'),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(),
    putImageData: vi.fn(),
    createImageData: vi.fn(),
    setTransform: vi.fn(),
    resetTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    transform: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn()
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,proofread');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('createAppRouter', () => {
  it('stores the local engine base url in route handles', () => {
    const router = createAppRouter({ apiBaseUrl: 'http://127.0.0.1:8765' });

    expect(router.routes[0].handle).toMatchObject({ apiBaseUrl: 'http://127.0.0.1:8765' });
  });

  it('loads the homepage with bookshelf cards and cover status badges', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (input === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => [
            {
              id: 'project-demo',
              title: '革命造反年代',
              currentStage: 'Metadata confirmation',
              createdAt: '2026-04-19T10:00:00Z',
              coverUrl: 'http://127.0.0.1:8765/projects/project-demo/cover.png'
            }
          ]
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });
    const router = createAppRouter({ initialEntries: ['/'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '新建项目' })).toHaveAttribute('href', '/projects/new?variant=a');
    expect(screen.queryByText('服务状态：正常')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '选择 PDF 文件' })).not.toBeInTheDocument();
    expect(screen.queryByText('进行中的项目')).not.toBeInTheDocument();
    expect(screen.getByText('革命造反年代')).toBeInTheDocument();
    const statusBadge = screen.getByText('确认书籍信息');
    expect(statusBadge).toHaveClass('project-card__status-badge');
    expect(statusBadge.parentElement).toHaveClass('bookshelf-card__cover-frame');
    expect(screen.getByAltText('革命造反年代 封面预览')).toHaveAttribute('src', 'http://127.0.0.1:8765/projects/project-demo/cover.png');
    expect(screen.queryByRole('link', { name: '进入处理' })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '革命造反年代 确认书籍信息' })).toHaveAttribute('href', '/projects/project-demo/metadata?variant=a');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/health', { method: 'GET' });
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects', { method: 'GET' });
    });
  });

  it('loads an empty homepage shelf when no projects exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (input === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });
    const router = createAppRouter({ initialEntries: ['/'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
  });

  it('opens the dedicated upload page from the homepage route', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (input === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });
    const router = createAppRouter({ initialEntries: ['/'] });

    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole('link', { name: '新建项目' }));

    expect(await screen.findByRole('heading', { name: '新建项目' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择 PDF 文件' })).toBeInTheDocument();
  });

  it('loads metadata confirmation data from the engine for the active project route param', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'project-ops-handbook',
        title: '工作手册',
        subtitle: '发布工作手册',
        authors: ['编校组'],
        language: 'chinese_cht',
        coverAssetId: 'cover-ops-handbook'
      })
    } as Response);
    const router = createAppRouter({ initialEntries: ['/projects/project-ops-handbook/metadata'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '确认书籍信息' })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('工作手册')).toBeInTheDocument();
    expect(screen.getByDisplayValue('编校组')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects/project-ops-handbook/metadata', { method: 'GET' });
    });
  });

  it('loads proofread workspace data from the engine for the active project route param', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === 'http://127.0.0.1:8765/proofread/project-ops-handbook/workspace') {
        return {
          ok: true,
          json: async () => ({
            status: 'ready',
            notice: null,
            preview: {
              page: 3,
              documentUrl: '/proofread/project-ops-handbook/source-pdf'
            },
            block: {
              id: 'heading-1',
              text: '开始'
            },
            toc: [{ id: 'toc-1', label: '第一章' }],
            issues: [
              {
                id: 'issue-heading-1',
                kind: 'heading_level_review',
                severity: 'medium',
                blockId: 'heading-1',
                message: '这个标题可能缺少章节层级，请核对。'
              }
            ]
          })
        } as Response;
      }

      if (input === 'http://127.0.0.1:8765/proofread/project-ops-handbook/source-pdf') {
        return {
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8)
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });
    const router = createAppRouter({ initialEntries: ['/projects/project-ops-handbook/proofread'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '文字和格式校对' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByAltText('第 3 页预览')).toHaveAttribute('src', 'data:image/png;base64,proofread');
    });
    expect(screen.getByRole('link', { name: '进入导出' })).toHaveAttribute('href', '/projects/project-ops-handbook/export?variant=a');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/proofread/project-ops-handbook/workspace', { method: 'GET' });
    });
  });

  it('shows a friendly fallback instead of the default router crash screen when proofread workspace loading fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === 'http://127.0.0.1:8765/proofread/missing-proof/workspace') {
        return {
          ok: false,
          status: 404,
          json: async () => ({ detail: 'source pdf not found' })
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });
    const router = createAppRouter({ initialEntries: ['/projects/missing-proof/proofread'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '页面加载失败' })).toBeInTheDocument();
    expect(screen.getByText('source pdf not found')).toBeInTheDocument();
    expect(screen.queryByText('Unexpected Application Error!')).not.toBeInTheDocument();
  });

  it('saves proofread block text using the route project id and shows confirmation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input === 'http://127.0.0.1:8765/proofread/project-ops-handbook/workspace') {
        return {
          ok: true,
          json: async () => ({
            status: 'ready',
            notice: null,
            preview: {
              page: 3,
              documentUrl: 'http://127.0.0.1:8765/proofread/project-ops-handbook/source-pdf'
            },
            block: {
              id: 'heading-1',
              text: '开始'
            },
            toc: [{ id: 'toc-1', label: '第一章' }],
            issues: [
              {
                id: 'issue-heading-1',
                kind: 'heading_level_review',
                severity: 'medium',
                blockId: 'heading-1',
                message: '这个标题可能缺少章节层级，请核对。'
              }
            ]
          })
        } as Response;
      }

      if (input === 'http://127.0.0.1:8765/proofread/project-ops-handbook/source-pdf') {
        return {
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8)
        } as Response;
      }

      if (input === 'http://127.0.0.1:8765/proofread/project-ops-handbook/blocks/heading-1') {
        return {
          ok: true,
          json: async () => ({
            item: {
              id: 'heading-1',
              type: 'heading',
              text: '第一章 开始',
              source_page: 3
            }
          })
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)} ${JSON.stringify(init)}`);
    });
    const router = createAppRouter({ initialEntries: ['/projects/project-ops-handbook/proofread'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '文字和格式校对' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('文字内容'), { target: { value: '第一章 开始' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/proofread/project-ops-handbook/blocks/heading-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '第一章 开始' })
      });
    });
    expect(await screen.findByText('当前文字已保存。请继续检查下一处，或确认本页已经校对完成。')).toBeInTheDocument();
  });

  it('loads quality status from the engine for the active project route param', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'blocked',
        checks: ['Resolve high-severity issues first']
      })
    } as Response);
    const router = createAppRouter({ initialEntries: ['/projects/project-ops-handbook/quality'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '质量检查' })).toBeInTheDocument();
    expect(screen.getByText('Resolve high-severity issues first')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/quality/project-ops-handbook', { method: 'GET' });
    });
  });

  it('loads export options from the engine for the active project route param', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        options: [
          { id: 'markdown', label: 'Export Markdown' },
          { id: 'html', label: 'Export HTML' },
          { id: 'epub', label: 'Export EPUB' },
          { id: 'jojo-rag', label: 'Export jojo-rag Package' }
        ]
      })
    } as Response);
    const router = createAppRouter({ initialEntries: ['/projects/project-ops-handbook/export'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '导出' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 HTML' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 EPUB' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 jojo-rag 包' })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/export/project-ops-handbook/options', { method: 'GET' });
    });
  });

  it('runs export from the active project route and shows the output path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === 'http://127.0.0.1:8765/export/project-ops-handbook/options') {
        return {
          ok: true,
          json: async () => ({
            options: [{ id: 'markdown', label: 'Export Markdown' }]
          })
        } as Response;
      }

      if (input === 'http://127.0.0.1:8765/export/project-ops-handbook/markdown') {
        return {
          ok: true,
          json: async () => ({
            path: 'C:/exports/project-ops-handbook/markdown/book.md'
          })
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });
    const router = createAppRouter({ initialEntries: ['/projects/project-ops-handbook/export'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('button', { name: '导出 Markdown' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/export/project-ops-handbook/markdown', { method: 'POST' });
    });
    expect(await screen.findByText('导出完成：C:/exports/project-ops-handbook/markdown/book.md')).toBeInTheDocument();
  });

  it('creates an isolated memory router per app instance', () => {
    const firstRouter = createAppRouter({ initialEntries: ['/projects/project-demo'] });
    const secondRouter = createAppRouter({ initialEntries: ['/projects/project-ops-handbook'] });

    expect(firstRouter).not.toBe(secondRouter);
    expect(firstRouter.state.location.pathname).toBe('/projects/project-demo');
    expect(secondRouter.state.location.pathname).toBe('/projects/project-ops-handbook');
  });

  it('reaches the metadata confirmation page for a newly created uploaded project', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input === 'http://127.0.0.1:8765/projects/generated-project/metadata') {
        return {
          ok: true,
          json: async () => ({
            id: 'generated-project',
            title: '革命造反年代',
            subtitle: null,
            authors: [],
            language: 'chinese_cht',
            coverAssetId: null
          })
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });
    const router = createAppRouter({ initialEntries: ['/projects/generated-project/metadata'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '确认书籍信息' })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('革命造反年代')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8765/projects/generated-project/metadata', { method: 'GET' });
    });
  });
});
