// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';

import App from './App';
import { buildApiUrl } from './lib/api';
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
  delete window.jojoPress;
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('App', () => {
  const getRequestUrl = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);

  it('uses the local engine base url when creating the router', () => {
    const router = createAppRouter({ apiBaseUrl: buildApiUrl('') });

    expect(router.routes[0].handle).toMatchObject({ apiBaseUrl: 'http://127.0.0.1:8765' });
  });

  it('prefers the Electron-provided api base url when available', async () => {
    window.jojoPress = {
      appName: 'jojo-press',
      apiBaseUrl: 'http://127.0.0.1:8766'
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8766/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8766/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
  });

  it('prefers the api base url from the window query string when provided', async () => {
    window.history.replaceState({}, '', '/?apiBaseUrl=http%3A%2F%2F127.0.0.1%3A8766');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8766/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8766/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
  });

  it('shows the homepage with bookshelf-style cards and cover status badges', async () => {
    delete window.jojoPress;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => [
            {
              id: 'project-demo',
              title: '革命造反年代',
              currentStage: 'Metadata confirmation',
              createdAt: '2026-04-19T10:00:00Z',
              coverUrl: 'http://127.0.0.1:8765/projects/project-demo/cover.png'
            },
            {
              id: 'project-second',
              title: '第二项目',
              currentStage: 'Proofreading workspace',
              createdAt: '2026-04-18T08:30:00Z',
              coverUrl: null
            }
          ]
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '新建项目' })).toHaveAttribute('href', '/projects/new?variant=a');
    expect(screen.queryByText('服务状态：正常')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '选择 PDF 文件' })).not.toBeInTheDocument();
    expect(screen.queryByText('进行中的项目')).not.toBeInTheDocument();
    expect(screen.getByText('革命造反年代')).toBeInTheDocument();
    expect(screen.getByText('第二项目')).toBeInTheDocument();
    expect(screen.getByText('确认书籍信息')).toBeInTheDocument();
    expect(screen.getByText('文字校对')).toBeInTheDocument();
    expect(screen.queryByText('2026-04-19')).not.toBeInTheDocument();
    expect(screen.getByAltText('革命造反年代 封面预览')).toHaveAttribute('src', 'http://127.0.0.1:8765/projects/project-demo/cover.png');
    expect(screen.getByAltText('第二项目 默认封面')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '进入处理' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '革命造反年代 确认书籍信息' })).toHaveAttribute('href', '/projects/project-demo/metadata?variant=a');
    expect(screen.getByRole('link', { name: '第二项目 文字校对' })).toHaveAttribute('href', '/projects/project-second/proofread?variant=a');
    const statusBadge = screen.getByText('确认书籍信息');
    expect(statusBadge).toHaveClass('project-card__status-badge');
    expect(statusBadge.parentElement).toHaveClass('bookshelf-card__cover-frame');
    expect(screen.getByAltText('革命造反年代 封面预览')).not.toHaveStyle({ borderRadius: '12px' });
    expect(screen.getByRole('heading', { name: '我的项目' }).closest('main')?.querySelector('.task-list')).toHaveClass('task-list--bookshelf');
  });

  it('hides stale seeded english projects from the homepage shelf', async () => {
    delete window.jojoPress;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => [
            { id: 'project-demo', title: 'Book Production Workspace', currentStage: 'Metadata confirmation' },
            { id: 'project-ops-handbook', title: 'Operations Handbook', currentStage: 'Proofreading workspace' }
          ]
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(screen.queryByText('Book Production Workspace')).not.toBeInTheDocument();
    expect(screen.queryByText('Operations Handbook')).not.toBeInTheDocument();
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
  });

  it('shows an empty project shelf when there are no projects yet', async () => {
    delete window.jojoPress;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
  });

  it('opens a dedicated upload page from the homepage new-project entry', async () => {
    delete window.jojoPress;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: '新建项目' }));

    expect(await screen.findByRole('heading', { name: '新建项目' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择 PDF 文件' })).toBeInTheDocument();
  });

  it('locks the Electron app to variant A and hides the variant switcher', async () => {
    window.history.replaceState({}, '', '/?variant=c');
    window.jojoPress = {
      appName: 'jojo-press',
      apiBaseUrl: 'http://127.0.0.1:8765'
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(document.body.dataset.mockVariant).toBe('a');
    expect(screen.queryByRole('button', { name: '版本 A：出版编辑版' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('界面版本切换')).not.toBeInTheDocument();
  });

  it('renders the project overview route with the expected engine payload shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8765/projects/project-demo') {
        return {
          ok: true,
          json: async () => ({
            id: 'project-demo',
            title: 'Book Production Workspace',
            currentStage: 'Metadata confirmation'
          })
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    const router = createAppRouter({ initialEntries: ['/projects/project-demo'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: 'Book Production Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '检查识别结果' })).toHaveAttribute('href', '/projects/project-demo/metadata');
  });

  it('navigates to the recognition tab immediately after upload, polls status, and then moves to metadata', async () => {
    let resolveCreateProject: (() => void) | undefined;
    const selectPdf = vi.fn().mockResolvedValue('file:///C:/books/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf');
    window.jojoPress = {
      appName: 'jojo-press',
      apiBaseUrl: 'http://127.0.0.1:8765',
      selectPdf
    } as NonNullable<typeof window.jojoPress> & { selectPdf: typeof selectPdf };

    const recognitionStatuses = [
      {
        project_id: 'generated-project',
        status: 'processing',
        engine: 'pipeline',
        language: 'chinese_cht',
        is_ocr: true,
        pdf_path: 'file:///C:/books/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'
      },
      {
        project_id: 'generated-project',
        status: 'completed',
        engine: 'pipeline',
        language: 'chinese_cht',
        is_ocr: true,
        pdf_path: 'file:///C:/books/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'
      }
    ];
    let recognitionPollCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = getRequestUrl(input);

      if (url === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects' && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects' && init?.method === 'POST') {
        await new Promise<void>((resolve) => {
          resolveCreateProject = resolve;
        });

        return {
          ok: true,
          json: async () => ({
            project_id: 'generated-project',
            name: '革命造反年代',
            current_stage: 'recognition'
          })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/tasks/generated-project/recognition/start' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            project_id: 'generated-project',
            status: 'queued',
            engine: 'pipeline',
            language: 'chinese_cht',
            is_ocr: true,
            pdf_path: 'file:///C:/books/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'
          })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/tasks/generated-project/recognition/status' && init?.method === 'GET') {
        const payload = recognitionStatuses[Math.min(recognitionPollCount, recognitionStatuses.length - 1)];
        recognitionPollCount += 1;
        return {
          ok: true,
          json: async () => payload
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects/generated-project/metadata') {
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

      throw new Error(`Unexpected fetch request: ${String(input)} ${JSON.stringify(init)}`);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: '新建项目' }));
    fireEvent.click(await screen.findByRole('button', { name: /选择 PDF 文件/ }));

    expect(selectPdf).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('正在创建项目…')).toBeInTheDocument();
    resolveCreateProject?.();

    expect(await screen.findByRole('heading', { name: '识别进行中' })).toBeInTheDocument();
    expect(screen.getByText('MinerU 正在处理当前项目。')).toBeInTheDocument();
    expect(screen.getByText('添加书籍信息')).toBeInTheDocument();
    expect(screen.getByText('文字和格式校对')).toBeInTheDocument();
    expect(screen.getByText('导出')).toBeInTheDocument();
    expect(screen.queryByText('上传 PDF')).not.toBeInTheDocument();
    expect(screen.queryByText('生成 EPUB')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(recognitionPollCount).toBeGreaterThanOrEqual(2);
    });
    expect(await screen.findByRole('heading', { name: '确认书籍信息' })).toBeInTheDocument();
  });

  it('lets the browser upload a PDF and lands on the recognition tab immediately', async () => {
    let resolveCreateProject: (() => void) | undefined;
    const browserFile = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], '革命造反年代.pdf', {
      type: 'application/pdf'
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = getRequestUrl(input);

      if (url === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects' && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects' && init?.method === 'POST') {
        await new Promise<void>((resolve) => {
          resolveCreateProject = resolve;
        });

        return {
          ok: true,
          json: async () => ({
            project_id: 'generated-project',
            name: '革命造反年代',
            current_stage: 'recognition'
          })
        } as Response;
      }

      if (
        url ===
          'http://127.0.0.1:8765/projects/generated-project/source-pdf?filename=%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf' &&
        init?.method === 'POST'
      ) {
        return {
          ok: true,
          json: async () => ({
            pdf_path: 'file:///C:/projects/generated-project/input/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'
          })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/tasks/generated-project/recognition/start' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            project_id: 'generated-project',
            status: 'queued',
            engine: 'pipeline',
            language: 'chinese_cht',
            is_ocr: true,
            pdf_path: 'file:///C:/projects/generated-project/input/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'
          })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/tasks/generated-project/recognition/status' && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => ({
            project_id: 'generated-project',
            status: 'processing',
            engine: 'pipeline',
            language: 'chinese_cht',
            is_ocr: true,
            pdf_path: 'file:///C:/projects/generated-project/input/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf'
          })
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)} ${JSON.stringify(init)}`);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: '新建项目' }));
    const uploadButton = await screen.findByRole('button', { name: /选择 PDF 文件/ });
    expect(uploadButton).toBeEnabled();
    fireEvent.click(uploadButton);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [browserFile] } });

    expect(await screen.findByText('正在创建项目…')).toBeInTheDocument();
    resolveCreateProject?.();
    expect(await screen.findByRole('heading', { name: '识别进行中' })).toBeInTheDocument();
    expect(screen.getByText('MinerU 正在处理当前项目。')).toBeInTheDocument();
  });

  it('shows a clear message when the operator cancels PDF selection', async () => {
    const selectPdf = vi.fn().mockResolvedValue(null);
    window.jojoPress = {
      appName: 'jojo-press',
      apiBaseUrl: 'http://127.0.0.1:8765',
      selectPdf
    } as NonNullable<typeof window.jojoPress> & { selectPdf: typeof selectPdf };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8765/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: '新建项目' }));
    fireEvent.click(await screen.findByRole('button', { name: /选择 PDF 文件/ }));

    expect(selectPdf).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('未选择文件，操作已取消')).toBeInTheDocument();
  });

  it('shows a clear error message when creating a project fails after picking a PDF', async () => {
    const selectPdf = vi.fn().mockResolvedValue('file:///C:/books/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf');
    window.jojoPress = {
      appName: 'jojo-press',
      apiBaseUrl: 'http://127.0.0.1:8765',
      selectPdf
    } as NonNullable<typeof window.jojoPress> & { selectPdf: typeof selectPdf };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = getRequestUrl(input);

      if (url === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects' && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects' && init?.method === 'POST') {
        return {
          ok: false,
          status: 500,
          json: async () => ({ detail: 'boom' })
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)} ${JSON.stringify(init)}`);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: '新建项目' }));
    fireEvent.click(await screen.findByRole('button', { name: /选择 PDF 文件/ }));

    expect(await screen.findByText('正在创建项目…')).toBeInTheDocument();
    expect(await screen.findByText('创建项目失败，请重试')).toBeInTheDocument();
  });

  it('shows a MinerU configuration error when recognition cannot start after project creation', async () => {
    let resolveCreateProject: (() => void) | undefined;
    const selectPdf = vi.fn().mockResolvedValue('file:///C:/books/%E9%9D%A9%E5%91%BD%E9%80%A0%E5%8F%8D%E5%B9%B4%E4%BB%A3.pdf');
    window.jojoPress = {
      appName: 'jojo-press',
      apiBaseUrl: 'http://127.0.0.1:8765',
      selectPdf
    } as NonNullable<typeof window.jojoPress> & { selectPdf: typeof selectPdf };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = getRequestUrl(input);

      if (url === 'http://127.0.0.1:8765/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects' && init?.method === 'GET') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/projects' && init?.method === 'POST') {
        await new Promise<void>((resolve) => {
          resolveCreateProject = resolve;
        });

        return {
          ok: true,
          json: async () => ({
            project_id: 'generated-project',
            name: '革命造反年代',
            current_stage: 'recognition'
          })
        } as Response;
      }

      if (url === 'http://127.0.0.1:8765/tasks/generated-project/recognition/start' && init?.method === 'POST') {
        return {
          ok: false,
          status: 503,
          json: async () => ({ detail: 'mineru gateway is not configured' })
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)} ${JSON.stringify(init)}`);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('link', { name: '新建项目' }));
    fireEvent.click(await screen.findByRole('button', { name: /选择 PDF 文件/ }));

    expect(await screen.findByText('正在创建项目…')).toBeInTheDocument();
    resolveCreateProject?.();
    expect(await screen.findByText('识别服务未配置：请配置 MinerU API 后重试')).toBeInTheDocument();
  });

  it('renders the proofreading workspace route', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8765/proofread/project-ops-handbook/workspace') {
        return {
          ok: true,
          json: async () => ({
            status: 'ready',
            notice: null,
            issues: [
              {
                id: 'issue-heading-1',
                kind: 'heading_level_review',
                severity: 'medium',
                blockId: 'heading-1',
                message: '这个标题可能缺少章节层级，请核对。'
              }
            ],
            preview: {
              page: 3,
              documentUrl: 'http://127.0.0.1:8765/proofread/project-ops-handbook/source-pdf'
            },
            block: {
              id: 'heading-1',
              text: '开始'
            },
            toc: [{ id: 'toc-1', label: '第一章' }]
          })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8765/proofread/project-ops-handbook/source-pdf') {
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
    expect(screen.getByText('待校对')).toBeInTheDocument();
    expect(screen.getByText('页面预览')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByAltText('第 3 页预览')).toHaveAttribute('src', 'data:image/png;base64,proofread');
    });
    expect(screen.getByText('文字编辑')).toBeInTheDocument();
  });

  it('opens the proofread route when the browser loads that project url directly', async () => {
    window.history.replaceState({}, '', '/projects/project-ops-handbook/proofread?apiBaseUrl=http%3A%2F%2F127.0.0.1%3A8766');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (getRequestUrl(input) === 'http://127.0.0.1:8766/health') {
        return {
          ok: true,
          json: async () => ({ status: 'ok' })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8766/projects') {
        return {
          ok: true,
          json: async () => []
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8766/proofread/project-ops-handbook/workspace') {
        return {
          ok: true,
          json: async () => ({
            status: 'recognition_pending',
            notice: 'MinerU 识别还没完成，当前还没有可校对文字。请先完成识别，再进入文字校对。',
            issues: [],
            preview: {
              page: 1,
              documentUrl: 'http://127.0.0.1:8766/proofread/project-ops-handbook/source-pdf'
            },
            block: null,
            toc: []
          })
        } as Response;
      }

      if (getRequestUrl(input) === 'http://127.0.0.1:8766/proofread/project-ops-handbook/source-pdf') {
        return {
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8)
        } as Response;
      }

      throw new Error(`Unexpected fetch request: ${String(input)}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '文字和格式校对' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('MinerU 识别还没完成，当前还没有可校对文字。请先完成识别，再进入文字校对。');
    await waitFor(() => {
      expect(screen.getByAltText('第 1 页预览')).toHaveAttribute('src', 'data:image/png;base64,proofread');
    });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8766/proofread/project-ops-handbook/workspace', { method: 'GET' });
  });

  it('shows a neutral boot shell without any visible brand copy while the initial route loader is still pending', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    render(<App />);

    expect(screen.getByLabelText('应用加载中')).toBeInTheDocument();
    expect(screen.queryByText('正在打开项目…')).not.toBeInTheDocument();
    expect(screen.queryByText('jojo-press')).not.toBeInTheDocument();
    expect(screen.queryByText('OCR 校对控制台')).not.toBeInTheDocument();
  });

  it('keeps the root route usable when the local engine is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    render(<App />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(screen.queryByText('服务状态：离线')).not.toBeInTheDocument();
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
  });
});
