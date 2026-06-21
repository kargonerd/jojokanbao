import { marked } from 'marked'
import type { ChatReference } from '../types'

export function renderMarkdown(content: string) {
  return marked.parse(content) as string
}

export function formatMessageMarkdown(content: string, references?: ChatReference[]) {
  let html = renderMarkdown(content)

  if (!references?.length) {
    return html
  }

  const refMap = new Map<number, ChatReference>()
  for (const ref of references) {
    refMap.set(ref.citation_number, ref)
  }

  return html.replace(/\[([^\]]+)\]/g, (match, inner) => {
    const numbers = inner.match(/\d+/g)
    if (!numbers?.length) {
      return match
    }

    const links = numbers
      .map((num: string) => Number(num))
      .filter((num: number) => refMap.has(num))
      .sort((a: number, b: number) => a - b)
      .map((num: number) => `<a class="citation-link" data-ref="${num}">${num}</a>`)

    return links.length ? links.join('') : match
  })
}
