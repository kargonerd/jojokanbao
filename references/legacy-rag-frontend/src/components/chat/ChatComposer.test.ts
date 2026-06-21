import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ChatComposer from './ChatComposer.vue'

function mountComposer(value = '问题', disabled = false) {
  return mount(ChatComposer, {
    props: {
      modelValue: value,
      disabled,
    },
  })
}

describe('ChatComposer', () => {
  it('emits send when Enter is pressed', async () => {
    const wrapper = mountComposer()

    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('keeps Shift Enter for newline input', async () => {
    const wrapper = mountComposer()

    await wrapper.find('textarea').trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('passes disabled state to the send button', () => {
    const wrapper = mountComposer('', true)

    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
  })
})
