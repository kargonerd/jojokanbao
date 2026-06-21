import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAutoScroll } from './useAutoScroll'

const Harness = defineComponent({
  setup() {
    const container = ref<HTMLElement | null>(null)
    const messages = ref<string[]>([])
    const streaming = ref('')
    const active = ref(false)
    const autoScroll = useAutoScroll(container, () => active.value)
    autoScroll.watchMessageScroll(messages)
    autoScroll.watchStreamingScroll(streaming)
    return { container, messages, streaming, active }
  },
  template: '<div ref="container"></div>',
})

describe('useAutoScroll', () => {
  it('scrolls for message changes and active streaming changes', async () => {
    const scrollTo = vi.fn()
    const wrapper = mount(Harness, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    Object.defineProperty(container, 'scrollHeight', { value: 120, configurable: true })
    container.scrollTo = scrollTo

    wrapper.vm.messages = ['hello']
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    wrapper.vm.active = true
    wrapper.vm.streaming = 'chunk'
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'smooth' })
    expect(scrollTo).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})
