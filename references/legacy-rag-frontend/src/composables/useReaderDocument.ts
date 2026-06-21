import { computed, reactive, ref } from 'vue'
import { catalogApi } from '../api'
import { buildFallbackToc, getVisibleAnnotations, normalizeReaderPreferences, renderReaderMarkdown } from '../utils/reader'
import type { ReaderConfig, SourceAnnotation, SourceChapterSummary, SourceDocument, SourceTocItem } from '../types'

export function useReaderDocument() {
  const sourceTitle = ref('')
  const markdown = ref('')
  const loadingDocument = ref(true)
  const loadingChapter = ref(false)
  const error = ref('')
  const activeHeading = ref('')
  const activeChapterId = ref('')
  const tableOfContents = ref<SourceTocItem[]>([])
  const chapterList = ref<SourceChapterSummary[]>([])
  const annotations = ref<SourceAnnotation[]>([])
  const readerPrefs = reactive({
    fontSize: 18,
    lineHeight: 1.8,
    contentWidth: '760px',
    theme: 'paper',
  })

  const readerStyle = computed(() => ({
    fontSize: `${readerPrefs.fontSize}px`,
    lineHeight: String(readerPrefs.lineHeight),
    maxWidth: readerPrefs.contentWidth,
  }))
  const visibleAnnotations = computed(() => getVisibleAnnotations(annotations.value, activeChapterId.value))
  const renderedContent = computed(() => renderReaderMarkdown(markdown.value))

  function applyReaderDefaults(config?: ReaderConfig) {
    const prefs = normalizeReaderPreferences(config)
    readerPrefs.fontSize = prefs.fontSize
    readerPrefs.lineHeight = prefs.lineHeight
    readerPrefs.contentWidth = prefs.contentWidth
    readerPrefs.theme = prefs.theme
  }

  function resetDocumentState() {
    loadingDocument.value = true
    error.value = ''
    sourceTitle.value = ''
    markdown.value = ''
    tableOfContents.value = []
    chapterList.value = []
    annotations.value = []
    activeHeading.value = ''
    activeChapterId.value = ''
  }

  async function loadDocument(notebookId: string, sourceId: string) {
    resetDocumentState()
    try {
      const payload: SourceDocument = await catalogApi.getSourceDocument(notebookId, sourceId)
      markdown.value = payload.text || ''
      sourceTitle.value = payload.source?.title || payload.title || sourceId
      chapterList.value = payload.chapters || []
      tableOfContents.value = payload.toc?.length ? payload.toc : buildFallbackToc(payload.text || '')
      annotations.value = payload.annotations || []
      applyReaderDefaults(payload.reader_config)

      if (chapterList.value.length > 0) {
        activeChapterId.value = chapterList.value[0].id
        const firstChapter = await catalogApi.getSourceChapter(notebookId, sourceId, chapterList.value[0].id)
        markdown.value = firstChapter.text || payload.text || ''
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载文档失败'
    } finally {
      loadingDocument.value = false
    }
  }

  async function loadChapter(notebookId: string, sourceId: string, chapterId: string) {
    activeChapterId.value = chapterId
    loadingChapter.value = true
    try {
      const payload = await catalogApi.getSourceChapter(notebookId, sourceId, chapterId)
      markdown.value = payload.text || ''
      activeHeading.value = ''
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载章节失败'
    } finally {
      loadingChapter.value = false
    }
  }

  return {
    sourceTitle,
    markdown,
    loadingDocument,
    loadingChapter,
    error,
    activeHeading,
    activeChapterId,
    tableOfContents,
    chapterList,
    annotations,
    readerPrefs,
    readerStyle,
    visibleAnnotations,
    renderedContent,
    loadDocument,
    loadChapter,
    resetDocumentState,
  }
}
