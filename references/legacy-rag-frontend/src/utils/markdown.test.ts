import { describe, expect, it } from 'vitest'
import { formatMessageMarkdown, renderMarkdown } from './markdown'
import type { ChatReference } from '../types'

function ref(citationNumber: number): ChatReference {
  return {
    citation_number: citationNumber,
    source_id: `source-${citationNumber}`,
    cited_text: `text ${citationNumber}`,
    start_char: null,
    end_char: null,
  }
}

describe('renderMarkdown', () => {
  it('renders markdown into html', () => {
    expect(renderMarkdown('## 标题')).toContain('<h2>标题</h2>')
  })
})

describe('formatMessageMarkdown', () => {
  it('turns matched citation numbers into citation links', () => {
    const html = formatMessageMarkdown('这是一段引用 [2]。', [ref(2)])

    expect(html).toContain('class="citation-link"')
    expect(html).toContain('data-ref="2"')
  })

  it('sorts multiple citation numbers and ignores unknown references', () => {
    const html = formatMessageMarkdown('混合引用 [3, 1, 9]', [ref(1), ref(3)])

    expect(html).toContain('data-ref="1"')
    expect(html).toContain('data-ref="3"')
    expect(html).not.toContain('data-ref="9"')
    expect(html.indexOf('data-ref="1"')).toBeLessThan(html.indexOf('data-ref="3"'))
  })

  it('leaves non-citation brackets unchanged', () => {
    const html = formatMessageMarkdown('这是 [不是引用]。', [ref(1)])

    expect(html).toContain('[不是引用]')
  })

  it('leaves citation brackets unchanged when no references match', () => {
    const html = formatMessageMarkdown('这是一段引用 [5]。', [ref(1)])

    expect(html).toContain('[5]')
    expect(html).not.toContain('citation-link')
  })
})
