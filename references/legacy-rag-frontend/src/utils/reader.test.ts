import { describe, expect, it } from 'vitest'
import {
  buildFallbackToc,
  createHeadingId,
  getVisibleAnnotations,
  normalizeReaderPreferences,
  renderReaderMarkdown,
} from './reader'
import type { SourceAnnotation } from '../types'

describe('createHeadingId', () => {
  it('creates stable ids from heading text', () => {
    expect(createHeadingId(1, '第一章：组织起来')).toBe('heading-1-第一章-组织起来')
  })
})

describe('buildFallbackToc', () => {
  it('builds toc entries from markdown headings', () => {
    expect(buildFallbackToc('# 序章\n正文\n## 第一节')).toEqual([
      { id: 'heading-0-序章', title: '序章', level: 1, order: 1 },
      { id: 'heading-1-第一节', title: '第一节', level: 2, order: 2 },
    ])
  })

  it('ignores non-heading lines', () => {
    expect(buildFallbackToc('正文\n- 列表')).toEqual([])
  })
})

describe('normalizeReaderPreferences', () => {
  it('uses provided reader config when valid', () => {
    expect(normalizeReaderPreferences({
      font_size: 20,
      line_height: 2,
      content_width: '900px',
      theme: 'dark',
    })).toEqual({ fontSize: 20, lineHeight: 2, contentWidth: '900px', theme: 'dark' })
  })

  it('falls back to defaults for missing or malformed values', () => {
    expect(normalizeReaderPreferences({ font_size: 0, content_width: 12 as unknown as string })).toEqual({
      fontSize: 18,
      lineHeight: 1.8,
      contentWidth: '760px',
      theme: 'paper',
    })
  })
})

describe('getVisibleAnnotations', () => {
  const annotations: SourceAnnotation[] = [
    { id: 'a', chapter_id: 'one', note: 'A' },
    { id: 'b', chapter_id: 'two', note: 'B' },
  ]

  it('filters annotations by active chapter', () => {
    expect(getVisibleAnnotations(annotations, 'two')).toEqual([annotations[1]])
  })

  it('falls back to all annotations when active chapter has none', () => {
    expect(getVisibleAnnotations(annotations, 'missing')).toEqual(annotations)
  })

  it('limits returned annotations', () => {
    expect(getVisibleAnnotations(annotations, '', 1)).toEqual([annotations[0]])
  })
})

describe('renderReaderMarkdown', () => {
  it('adds stable ids to rendered headings', () => {
    const html = renderReaderMarkdown('# 序章')

    expect(html).toContain('<h1 id="heading-0-序章">序章</h1>')
  })
})
