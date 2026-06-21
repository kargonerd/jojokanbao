import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useRotatingLoadingText } from './useRotatingLoadingText'

const Harness = defineComponent({
  setup() {
    const active = ref(false)
    const { loadingText } = useRotatingLoadingText(active, ['一', '二'], 1000)
    return { active, loadingText }
  },
  template: '<span>{{ loadingText }}</span>',
})

describe('useRotatingLoadingText', () => {
  it('rotates text while active and clears timer on unmount', async () => {
    vi.useFakeTimers()
    const wrapper = mount(Harness)

    expect(wrapper.text()).toBe('一')
    wrapper.vm.active = true
    await wrapper.vm.$nextTick()
    vi.advanceTimersByTime(1000)
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toBe('二')
    wrapper.unmount()
    vi.useRealTimers()
  })
})
