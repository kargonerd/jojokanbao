import { marked } from 'marked'
import type { ReaderConfig, SourceAnnotation, SourceTocItem } from '../types'

export interface ReaderPreferences {
  fontSize: number
  lineHeight: number
  contentWidth: string
  theme: string
}

export const defaultReaderPreferences: ReaderPreferences = {
  fontSize: 18,
  lineHeight: 1.8,
  contentWidth: '760px',
  theme: 'paper',
}

export function createHeadingId(index: number, title: string) {
  return `heading-${index}-${title.slice(0, 20).replace(/[^\w一-龥]/g, '-')}`
}

export function buildFallbackToc(text: string): SourceTocItem[] {
  const toc: SourceTocItem[] = []
  let headingIndex = 0

  text.split('\n').forEach(line => {
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (!match) return

    const title = match[2].trim()
    toc.push({
      id: createHeadingId(headingIndex, title),
      title,
      level: match[1].length,
      order: headingIndex + 1,
    })
    headingIndex += 1
  })

  return toc
}

export function normalizeReaderPreferences(config?: ReaderConfig): ReaderPreferences {
  return {
    fontSize: Number(config?.font_size) || defaultReaderPreferences.fontSize,
    lineHeight: Number(config?.line_height) || defaultReaderPreferences.lineHeight,
    contentWidth: typeof config?.content_width === 'string' ? config.content_width : defaultReaderPreferences.contentWidth,
    theme: typeof config?.theme === 'string' ? config.theme : defaultReaderPreferences.theme,
  }
}

export function getVisibleAnnotations(annotations: SourceAnnotation[], activeChapterId: string, limit = 20) {
  if (!activeChapterId) {
    return annotations.slice(0, limit)
  }

  const filtered = annotations.filter(item => item.chapter_id === activeChapterId)
  return (filtered.length > 0 ? filtered : annotations).slice(0, limit)
}

export function renderReaderMarkdown(markdown: string) {
  if (!markdown) return ''

  let headingIndex = 0
  return String(marked.parse(markdown)).replace(/<h([1-6])>(.*?)<\/h[1-6]>/g, (_match, level, text) => {
    const cleanText = String(text).replace(/<[^>]+>/g, '').trim()
    const id = createHeadingId(headingIndex, cleanText)
    headingIndex += 1
    return `<h${level} id="${id}">${text}</h${level}>`
  })
}
