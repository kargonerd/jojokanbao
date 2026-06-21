import { describe, expect, it, vi } from 'vitest'
import { useReaderDocument } from './useReaderDocument'
import { catalogApi } from '../api'

vi.mock('../api', () => ({
  catalogApi: {
    getSourceDocument: vi.fn(),
    getSourceChapter: vi.fn(),
  },
}))

const mockedCatalogApi = vi.mocked(catalogApi)

describe('useReaderDocument', () => {
  it('loads document metadata and first chapter when chapters exist', async () => {
    mockedCatalogApi.getSourceDocument.mockResolvedValue({
      id: 'src-1',
      title: '文档标题',
      text: '# 汇总',
      chapters: [{ id: 'chapter-1', title: '第一章' }],
      annotations: [{ chapter_id: 'chapter-1', quote: '引文', note: '注解' }],
      reader_config: { font_size: 20, theme: 'dark' },
    })
    mockedCatalogApi.getSourceChapter.mockResolvedValue({
      id: 'chapter-1',
      title: '第一章',
      text: '# 第一章',
    })

    const reader = useReaderDocument()
    await reader.loadDocument('nb-1', 'src-1')

    expect(reader.sourceTitle.value).toBe('文档标题')
    expect(reader.activeChapterId.value).toBe('chapter-1')
    expect(reader.renderedContent.value).toContain('第一章')
    expect(reader.readerPrefs.fontSize).toBe(20)
    expect(reader.readerPrefs.theme).toBe('dark')
    expect(reader.visibleAnnotations.value).toHaveLength(1)
  })

  it('sets a readable error when chapter loading fails', async () => {
    mockedCatalogApi.getSourceChapter.mockRejectedValue(new Error('章节不存在'))

    const reader = useReaderDocument()
    await reader.loadChapter('nb-1', 'src-1', 'missing')

    expect(reader.activeChapterId.value).toBe('missing')
    expect(reader.error.value).toBe('章节不存在')
    expect(reader.loadingChapter.value).toBe(false)
  })
})
