import type {
  MockExportPlan,
  MockMetadataDraft,
  MockRecognitionState,
  MockStructuredOutputPreview,
  MockTaskSummary
} from '../types/project';
import type { ProofreadWorkspace } from '../types/issues';

export const mockTasks: MockTaskSummary[] = [
  {
    id: 'mock-1',
    title: '革命造反年代',
    currentStep: '识别中',
    progressPercent: 18,
    progressLabel: 'MinerU 识别到第 42 页',
    updatedAt: '2 分钟前',
    nextHref: '/projects/mock-1/recognition',
    ctaLabel: '继续查看',
    tone: 'active'
  },
  {
    id: 'mock-2',
    title: '毛泽东选集（第一卷）',
    currentStep: '元数据确认',
    progressPercent: 42,
    progressLabel: '封面与作者待确认',
    updatedAt: '今天 14:20',
    nextHref: '/projects/mock-1/metadata',
    ctaLabel: '继续确认',
    tone: 'ready'
  },
  {
    id: 'mock-3',
    title: '中国革命史讲义',
    currentStep: '文字校对',
    progressPercent: 76,
    progressLabel: '已完成 228 / 300 个文本块',
    updatedAt: '昨天 21:16',
    nextHref: '/projects/mock-1/proofread',
    ctaLabel: '继续校对',
    tone: 'ready'
  },
  {
    id: 'mock-4',
    title: '近代思想史资料',
    currentStep: '可导出 EPUB',
    progressPercent: 100,
    progressLabel: '结构化书稿已生成',
    updatedAt: '昨天 18:03',
    nextHref: '/projects/mock-1/export',
    ctaLabel: '查看导出',
    tone: 'complete'
  }
];

export const mockRecognitionState: MockRecognitionState = {
  projectId: 'mock-1',
  title: '革命造反年代',
  fileName: '革命造反年代.pdf',
  engine: 'MinerU',
  totalPages: 318,
  processedPages: 42,
  currentPhase: '版面分析与 OCR',
  statusText: 'MinerU 正在处理这本书的版面与文字识别。',
  estimateLabel: '预计还需 6 分钟',
  nextHref: '/projects/mock-1/metadata'
};

export const mockMetadataDraft: MockMetadataDraft = {
  id: 'mock-1',
  title: '革命造反年代',
  subtitle: '群众运动与时代回声',
  authors: ['张三', '李四'],
  authorsText: '张三, 李四',
  language: 'zh-CN',
  coverAssetId: 'cover-page-1',
  sourceFileName: '革命造反年代.pdf',
  confidenceNote: '书名与作者由第一页、版权页候选信息自动预填。',
  nextHref: '/projects/mock-1/proofread',
  coverCandidates: [
    { pageNumber: 1, label: '第 1 页', excerpt: '默认封面，识别到完整标题与主视觉。' },
    { pageNumber: 2, label: '第 2 页', excerpt: '扉页候选，标题较完整但无封面图。' },
    { pageNumber: 3, label: '第 3 页', excerpt: '版权页候选，作者信息较完整。' }
  ]
};

export const mockProofreadWorkspace: ProofreadWorkspace = {
  status: 'ready',
  notice: null,
  documentTitle: '革命造反年代',
  checkedCount: 228,
  totalBlocks: 300,
  selectedBlockId: 'block-2',
  autosave: {
    status: 'saved',
    message: '已自动保存到第 12 页 · 1 分钟前'
  },
  issues: [
    { id: 'issue-1', kind: 'heading_level_review', severity: 'medium', blockId: 'block-1', message: '段落 1：标题层级待确认' },
    { id: 'issue-2', kind: 'heading_level_review', severity: 'low', blockId: 'block-2', message: '段落 2：正文可直接确认' },
    { id: 'issue-3', kind: 'heading_level_review', severity: 'high', blockId: 'block-3', message: '脚注疑似有缺字' }
  ],
  preview: {
    page: 12,
    totalPages: 318,
    pages: [
      { pageNum: 11, content: '上一页内容摘要' },
      {
        pageNum: 12,
        content: '当前页',
        blocks: [
          { id: 'block-1', type: 'heading', text: '第二章 群众动员的开端', bbox: { x: 18, y: 12, width: 52, height: 8 }, level: 1 },
          { id: 'block-2', type: 'paragraph', text: '群众在会场上高呼口号，随后开始讨论新的宣传提纲。', bbox: { x: 18, y: 32, width: 58, height: 12 }, level: 0 },
          { id: 'block-3', type: 'footnote', text: '原文刊于一九六六年八月内部简报。', bbox: { x: 18, y: 78, width: 48, height: 8 }, level: 0 }
        ]
      },
      { pageNum: 13, content: '下一页内容摘要' }
    ]
  },
  block: {
    id: 'block-2',
    label: '正文 02',
    text: '群众在会场上高呼口号，随后开始讨论新的宣传提纲。',
    originalText: '群众在会场上高呼口号，随后开始讨论新的宣传提纲。',
    pageNumber: 12,
    kind: 'body',
    fontSize: 14,
    fontWeight: 'regular',
    checked: false,
    bbox: { x: 18, y: 32, width: 58, height: 12 }
  },
  blocks: [
    {
      id: 'block-1',
      label: '标题 01',
      text: '第二章 群众动员的开端',
      originalText: '第二章 群众动员的开端',
      pageNumber: 12,
      kind: 'heading',
      fontSize: 24,
      fontWeight: 'bold',
      checked: true,
      bbox: { x: 18, y: 12, width: 52, height: 8 }
    },
    {
      id: 'block-2',
      label: '正文 02',
      text: '群众在会场上高呼口号，随后开始讨论新的宣传提纲。',
      originalText: '群众在会场上高呼口号，随后开始讨论新的宣传提纲。',
      pageNumber: 12,
      kind: 'body',
      fontSize: 14,
      fontWeight: 'regular',
      checked: false,
      bbox: { x: 18, y: 32, width: 58, height: 12 }
    },
    {
      id: 'block-3',
      label: '脚注 03',
      text: '原文刊于一九六六年八月内部简报。',
      originalText: '原文刊于一九六六年八月内部简报。',
      pageNumber: 12,
      kind: 'footnote',
      fontSize: 11,
      fontWeight: 'regular',
      checked: false,
      bbox: { x: 18, y: 78, width: 48, height: 8 }
    }
  ],
  nonTextRegions: [
    {
      id: 'image-1',
      pageNumber: 12,
      kind: 'image',
      label: '插图 01',
      bbox: { x: 70, y: 28, width: 14, height: 20 }
    }
  ],
  toc: [
    { id: 'toc-1', label: '第一章 前言' },
    { id: 'toc-2', label: '第二章 群众动员的开端' },
    { id: 'toc-3', label: '第三章 运动升级' }
  ]
};

export const mockStructuredOutput: MockStructuredOutputPreview = {
  title: '革命造反年代',
  summary: ['元数据已确认', '目录已整理', '正文与脚注已拆分', '可以生成 EPUB'],
  sections: [
    { id: 'metadata', label: '元数据', count: 8, description: '书名、作者、语言、封面等字段已完成。' },
    { id: 'toc', label: '目录', count: 16, description: '章节层级与页码映射已建立。' },
    { id: 'headings', label: '标题', count: 37, description: '标题层级与样式已从 bbox 校对结果生成。' },
    { id: 'body', label: '正文', count: 228, description: '正文段落已根据页面块归并。' },
    { id: 'footnotes', label: '脚注', count: 42, description: '脚注块已单独提取并关联正文。' }
  ],
  exportHref: '/projects/mock-1/export'
};

export const mockExportPlan: MockExportPlan = {
  title: '革命造反年代',
  destination: 'exports/革命造反年代/revolution.epub',
  targets: [
    { id: 'epub', label: 'EPUB', description: '根据结构化书稿生成可阅读的 EPUB 文件。', primary: true },
    { id: 'html', label: 'HTML', description: '导出带基础排版样式的单文件 HTML。' },
    { id: 'markdown', label: 'Markdown', description: '导出章节化 Markdown 作为中间稿。' },
    { id: 'jojo-rag', label: 'jojo-rag 包', description: '导出供检索和知识库使用的结构化包。' }
  ]
};
