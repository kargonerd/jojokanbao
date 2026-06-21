import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ChatSidebar from './ChatSidebar.vue'
import type { Notebook, Source } from '../../types'

const notebooks: Notebook[] = [
  { id: 'nb-1', title: '第一本文库', source_count: 2 },
  { id: 'nb-2', title: '第二本文库', source_count: 1 },
]

const sources: Source[] = [
  { id: 'src-1', title: '第一篇', notebook_id: 'nb-1', kind: 'document' },
  { id: 'src-2', title: '第二篇', notebook_id: 'nb-1', kind: 'document' },
]

function mountSidebar() {
  return mount(ChatSidebar, {
    props: {
      notebooks,
      selectedNotebook: notebooks[0],
      sources,
      selectedSourceIds: ['src-1'],
      loadingNotebooks: false,
    },
    global: {
      stubs: { Simplebar: { template: '<div><slot /></div>' } },
    },
  })
}

describe('ChatSidebar', () => {
  it('renders notebooks and sources', () => {
    const wrapper = mountSidebar()

    expect(wrapper.text()).toContain('第一本文库')
    expect(wrapper.text()).toContain('第一篇')
    expect(wrapper.findAll('.sidebar-item')[0].classes()).toContain('active')
  })

  it('emits selection events', async () => {
    const wrapper = mountSidebar()

    await wrapper.findAll('.sidebar-item')[1].trigger('click')
    await wrapper.find('input[type="checkbox"]').trigger('change')
    await wrapper.find('.source-link').trigger('click')
    await wrapper.find('.mini-btn').trigger('click')

    expect(wrapper.emitted('selectNotebook')?.[0]).toEqual([notebooks[1]])
    expect(wrapper.emitted('selectSource')?.[0]).toEqual(['src-1'])
    expect(wrapper.emitted('openSource')?.[0]).toEqual([sources[0]])
    expect(wrapper.emitted('selectAllSources')).toHaveLength(1)
  })
})
