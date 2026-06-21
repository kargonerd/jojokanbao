import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MessageBubble from './MessageBubble.vue'
import type { ChatReference, Message } from '../../types'

const reference: ChatReference = {
  citation_number: 1,
  source_id: 'source-1',
  cited_text: null,
  start_char: null,
  end_char: null,
}

const message: Message = {
  id: 'm1',
  role: 'assistant',
  content: '回答 [1]',
  references: [reference],
  timestamp: new Date('2026-01-01T00:00:00.000Z'),
}

describe('MessageBubble', () => {
  it('renders message markdown and emits citation clicks', async () => {
    const wrapper = mount(MessageBubble, { props: { message } })

    await wrapper.find('.citation-link').trigger('click')

    expect(wrapper.html()).toContain('回答')
    expect(wrapper.emitted('citation')?.[0]).toEqual([reference])
  })

  it('emits copy for persisted messages', async () => {
    const wrapper = mount(MessageBubble, { props: { message } })

    await wrapper.find('.text-action').trigger('click')

    expect(wrapper.emitted('copy')?.[0]).toEqual([message])
  })

  it('renders loading text without copy action', () => {
    const wrapper = mount(MessageBubble, {
      props: { role: 'assistant', loadingText: '正在检索相关资料...' },
    })

    expect(wrapper.text()).toContain('正在检索相关资料...')
    expect(wrapper.find('.text-action').exists()).toBe(false)
  })
})
