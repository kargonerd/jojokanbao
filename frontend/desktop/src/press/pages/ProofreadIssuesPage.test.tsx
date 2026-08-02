// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      getPage: async () => ({
        getViewport: ({ scale = 1 }: { scale?: number }) => ({ width: 500 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve() })
      })
    })
  }))
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdfjsMock);

import { ProofreadIssuesPage } from './ProofreadIssuesPage';

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
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8)
  } as Response);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import type { ProofreadWorkspace } from '../types/issues';

describe('ProofreadIssuesPage', () => {
  it('shows the proofreading workspace from loader-backed project data', async () => {
    const workspace: ProofreadWorkspace = {
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
        documentUrl: 'jojo-pdf://project/project-ops-handbook'
      },
      block: {
        id: 'heading-1',
        text: '开始'
      },
      toc: [{ id: 'toc-1', label: '第一章' }]
    };

    render(
      <MemoryRouter>
        <ProofreadIssuesPage workspace={workspace} />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: '文字和格式校对' })).toBeInTheDocument();
    expect(screen.queryByText('识别')).not.toBeInTheDocument();
    expect(screen.queryByText('添加书籍信息')).not.toBeInTheDocument();
    expect(screen.queryByText('上传 PDF')).not.toBeInTheDocument();
    expect(screen.getByText('待校对')).toBeInTheDocument();
    expect(screen.getByText('页面预览')).toBeInTheDocument();
    expect(screen.getByText('第 3 页')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByAltText('第 3 页预览')).toHaveAttribute('src', 'data:image/png;base64,proofread');
    });
    expect(screen.getByText('文字编辑')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '进入导出' })).toHaveAttribute('href', '/press/projects/mock-1/export?variant=a');
    expect(screen.getByDisplayValue('开始')).toBeInTheDocument();
    expect(screen.getByText('格式')).toBeInTheDocument();
    expect(screen.queryByText('目录结构')).not.toBeInTheDocument();
  });

  it('lets the operator edit and save the active block', async () => {
    const workspace: ProofreadWorkspace = {
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
        documentUrl: 'jojo-pdf://project/project-ops-handbook'
      },
      block: {
        id: 'heading-1',
        text: '开始'
      },
      toc: [{ id: 'toc-1', label: '第一章' }]
    };
    const onSaveBlock = vi.fn().mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <ProofreadIssuesPage workspace={workspace} onSaveBlock={onSaveBlock} />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText('文字内容'), { target: { value: '第一章 开始' } });

    expect(screen.getByText('当前修改已暂存，点击保存后写入项目。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));

    await waitFor(() => {
      expect(onSaveBlock).toHaveBeenCalledWith({
        blockId: 'heading-1',
        text: '第一章 开始'
      });
    });
  });

  it('shows a save confirmation after the block is saved', async () => {
    const workspace: ProofreadWorkspace = {
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
        documentUrl: 'jojo-pdf://project/project-ops-handbook'
      },
      block: {
        id: 'heading-1',
        text: '开始'
      },
      toc: [{ id: 'toc-1', label: '第一章' }]
    };

    render(
      <MemoryRouter>
        <ProofreadIssuesPage workspace={workspace} onSaveBlock={vi.fn().mockResolvedValue(undefined)} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));

    expect(await screen.findByText('当前文字已保存。请继续检查下一处，或确认本页已经校对完成。')).toBeInTheDocument();
  });

  it('shows a plain-language proofreading checklist for the active page', () => {
    const workspace: ProofreadWorkspace = {
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
        documentUrl: 'jojo-pdf://project/project-ops-handbook'
      },
      block: {
        id: 'heading-1',
        text: '开始'
      },
      toc: [{ id: 'toc-1', label: '第一章' }]
    };

    render(
      <MemoryRouter>
        <ProofreadIssuesPage workspace={workspace} />
      </MemoryRouter>
    );

    expect(screen.queryByText('请对照扫描页检查识别结果，并校对文字与格式后保存。')).not.toBeInTheDocument();
    expect(screen.getByText('第 3 页 · 0 个文本块')).toBeInTheDocument();
  });

  it('renders bbox overlays for the current page and highlights the selected block', () => {
    const workspace: ProofreadWorkspace = {
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
        documentUrl: 'jojo-pdf://project/project-ops-handbook',
        pages: [
          {
            pageNum: 3,
            blocks: [
              {
                id: 'heading-1',
                type: 'heading',
                text: '开始',
                bbox: { x: 12, y: 20, width: 32, height: 10 },
                level: 1
              },
              {
                id: 'paragraph-1',
                type: 'paragraph',
                text: '正文',
                bbox: { x: 10, y: 40, width: 70, height: 12 },
                level: 0
              }
            ]
          }
        ],
        totalPages: 1
      },
      block: {
        id: 'heading-1',
        text: '开始',
        bbox: { x: 12, y: 20, width: 32, height: 10 }
      },
      blocks: [
        {
          id: 'heading-1',
          text: '开始',
          bbox: { x: 12, y: 20, width: 32, height: 10 }
        },
        {
          id: 'paragraph-1',
          text: '正文',
          bbox: { x: 10, y: 40, width: 70, height: 12 }
        }
      ],
      toc: [{ id: 'toc-1', label: '第一章' }]
    };

    render(
      <MemoryRouter>
        <ProofreadIssuesPage workspace={workspace} />
      </MemoryRouter>
    );

    const selectedOverlay = screen.getByLabelText('heading-1 bbox');
    const secondaryOverlay = screen.getByLabelText('paragraph-1 bbox');

    expect(selectedOverlay).toHaveClass('page-canvas__bbox', 'page-canvas__bbox--selected');
    expect(selectedOverlay).toHaveStyle({ left: '12%', top: '20%', width: '32%', height: '10%' });
    expect(secondaryOverlay).toHaveClass('page-canvas__bbox');
    expect(secondaryOverlay).not.toHaveClass('page-canvas__bbox--selected');
    expect(secondaryOverlay).toHaveStyle({ left: '10%', top: '40%', width: '70%', height: '12%' });
  });

  it('renders bbox overlays even when only mock page data is available', () => {
    const workspace: ProofreadWorkspace = {
      status: 'ready',
      notice: null,
      issues: [],
      preview: {
        page: 12,
        pages: [
          {
            pageNum: 12,
            content: '当前页',
            blocks: [
              {
                id: 'block-2',
                type: 'paragraph',
                text: '群众在会场上高呼口号，随后开始讨论新的宣传提纲。',
                bbox: { x: 18, y: 32, width: 58, height: 12 },
                level: 0
              }
            ]
          }
        ],
        totalPages: 1
      },
      block: {
        id: 'block-2',
        text: '群众在会场上高呼口号，随后开始讨论新的宣传提纲。',
        bbox: { x: 18, y: 32, width: 58, height: 12 }
      },
      blocks: [
        {
          id: 'block-2',
          text: '群众在会场上高呼口号，随后开始讨论新的宣传提纲。',
          bbox: { x: 18, y: 32, width: 58, height: 12 }
        }
      ],
      toc: []
    };

    render(
      <MemoryRouter>
        <ProofreadIssuesPage workspace={workspace} />
      </MemoryRouter>
    );

    expect(screen.getByLabelText('block-2 bbox')).toBeInTheDocument();
    expect(screen.queryByText('暂无可用预览')).not.toBeInTheDocument();
  });

  it('sets the PDF.js worker source before rendering the preview', () => {
    expect(GlobalWorkerOptions.workerSrc).not.toBe('');
  });

  it('renders real MinerU bbox coordinates in the same pixel viewport as the PDF.js page preview', async () => {
    const workspace: ProofreadWorkspace = {
      status: 'ready',
      notice: null,
      issues: [],
      preview: {
        page: 1,
        documentUrl: 'jojo-pdf://project/generated-project',
        pages: [
          {
            pageNum: 1,
            blocks: [
              {
                id: 'block-1',
                type: 'text',
                text: '革命造反年代',
                bbox: { x: 64, y: 92, width: 834, height: 94 },
                level: 1
              }
            ]
          }
        ],
        totalPages: 20
      },
      block: {
        id: 'block-1',
        text: '革命造反年代',
        bbox: { x: 64, y: 92, width: 834, height: 94 }
      },
      blocks: [
        {
          id: 'block-1',
          text: '革命造反年代',
          bbox: { x: 64, y: 92, width: 834, height: 94 }
        }
      ],
      toc: []
    };

    render(
      <MemoryRouter>
        <ProofreadIssuesPage workspace={workspace} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByAltText('第 1 页预览')).toHaveAttribute('src', 'data:image/png;base64,proofread');
    });

    expect(screen.queryByTitle('第 1 页预览')).not.toBeInTheDocument();
    expect(screen.getByLabelText('block-1 bbox')).toHaveStyle({
      left: '32px',
      top: '73.6px',
      width: '417px',
      height: '75.2px'
    });
  });

  it('blocks proofreading when MinerU recognition is not finished yet', async () => {
    const workspace: ProofreadWorkspace = {
      status: 'recognition_pending',
      notice: 'MinerU 识别还没完成，当前还没有可校对文字。请先完成识别，再进入文字校对。',
      issues: [],
      preview: {
        page: 1,
        documentUrl: 'jojo-pdf://project/generated-project'
      },
      block: null,
      toc: []
    };

    render(
      <MemoryRouter>
        <ProofreadIssuesPage workspace={workspace} />
      </MemoryRouter>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('MinerU 识别还没完成，当前还没有可校对文字。请先完成识别，再进入文字校对。');
    await waitFor(() => {
      expect(screen.getByAltText('第 1 页预览')).toHaveAttribute('src', 'data:image/png;base64,proofread');
    });
    expect(screen.queryByText('待校对')).not.toBeInTheDocument();
    expect(screen.queryByText('文字编辑')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存并继续' })).not.toBeInTheDocument();
  });
});
