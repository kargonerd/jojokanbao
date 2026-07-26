import { cleanup, render, screen } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from './router';

function getRequestUrl(input: RequestInfo | URL) {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = getRequestUrl(input);

    if (url === 'http://127.0.0.1:8765/health') {
      return {
        ok: true,
        json: async () => ({ status: 'ok' })
      } as Response;
    }

    if (url === 'http://127.0.0.1:8765/projects') {
      return {
        ok: true,
        json: async () => []
      } as Response;
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('mock workflow routes', () => {
  it('renders the real project shelf on the home route', async () => {
    const router = createAppRouter({ initialEntries: ['/'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '新建项目' })).toHaveAttribute('href', '/projects/new?variant=a');
    expect(screen.getByText('还没有项目')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '选择 PDF 文件' })).not.toBeInTheDocument();
  });

  it('renders the recognition waiting page', async () => {
    const router = createAppRouter({ initialEntries: ['/projects/mock-1/recognition'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '识别进行中' })).toBeInTheDocument();
    expect(screen.getByText('MinerU 正在处理这本书的版面与文字识别。')).toBeInTheDocument();
    expect(screen.getByText('已处理 42 / 318 页')).toBeInTheDocument();
  });

  it('renders metadata review with cover candidates', async () => {
    const router = createAppRouter({ initialEntries: ['/projects/mock-1/metadata'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '确认书籍信息' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第 1 页封面候选' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第 2 页封面候选' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('革命造反年代')).toBeInTheDocument();
    expect(screen.getByDisplayValue('张三, 李四')).toBeInTheDocument();
  });

  it('renders the proofreading workbench with three columns', async () => {
    const router = createAppRouter({ initialEntries: ['/projects/mock-1/proofread'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '文字和格式校对' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '待校对' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '页面预览' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '文字编辑' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '标记无误' })).toBeInTheDocument();
  });

  it('renders the structured review page', async () => {
    const router = createAppRouter({ initialEntries: ['/projects/mock-1/structured'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '结构化结果' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '目录' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '脚注' })).toBeInTheDocument();
  });

  it('renders the export page with the available output targets', async () => {
    const router = createAppRouter({ initialEntries: ['/projects/mock-1/export'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '导出' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成导出文件' })).toBeInTheDocument();
    expect(screen.queryByText('校对完成后可根据结构化书稿生成导出文件。')).not.toBeInTheDocument();
  });

  it('hides the variant switcher on the real project list', async () => {
    const router = createAppRouter({ initialEntries: ['/'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(screen.queryByLabelText('界面版本切换')).not.toBeInTheDocument();
  });

  it('preserves the selected variant on project creation links', async () => {
    const router = createAppRouter({ initialEntries: ['/?variant=c'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(document.body.dataset.mockVariant).toBe('c');
    expect(screen.getByRole('link', { name: '新建项目' })).toHaveAttribute('href', '/projects/new?variant=c');
    expect(router.state.location.search).toBe('?variant=c');
  });

  it('applies variant b theme data on the real project list', async () => {
    const router = createAppRouter({ initialEntries: ['/?variant=b'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: '我的项目' })).toBeInTheDocument();
    expect(document.body.dataset.mockVariant).toBe('b');
    expect(screen.getByRole('link', { name: '新建项目' })).toHaveAttribute('href', '/projects/new?variant=b');
    expect(screen.getByText('将扫描版 PDF 转换为可编辑、可导出的结构化书籍数据')).toBeInTheDocument();
  });
});
