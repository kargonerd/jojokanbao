import { describe, expect, it } from 'vitest'
import { formatPublishReasons } from './publishReasons'

describe('formatPublishReasons', () => {
  it('formats known reason codes in order', () => {
    expect(formatPublishReasons(['missing_title', 'missing_document'])).toBe('缺少标题、缺少文档')
  })

  it('keeps unknown reason codes visible', () => {
    expect(formatPublishReasons(['custom_reason'])).toBe('custom_reason')
  })

  it('handles empty or missing reason lists', () => {
    expect(formatPublishReasons()).toBe('')
    expect(formatPublishReasons([])).toBe('')
  })
})
