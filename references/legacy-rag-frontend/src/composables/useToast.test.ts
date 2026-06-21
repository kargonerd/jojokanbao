import { describe, expect, it, vi } from 'vitest'
import { useToast } from './useToast'

describe('useToast', () => {
  it('shows and clears toast messages', () => {
    vi.useFakeTimers()
    const { toast, showToast, clearToast } = useToast(1000)

    showToast('保存成功')
    expect(toast.value).toEqual({ message: '保存成功', type: 'success' })

    clearToast()
    expect(toast.value).toBeNull()
    vi.useRealTimers()
  })

  it('auto clears the active toast after timeout', () => {
    vi.useFakeTimers()
    const { toast, showToast } = useToast(1000)

    showToast('失败', 'error')
    vi.advanceTimersByTime(1000)

    expect(toast.value).toBeNull()
    vi.useRealTimers()
  })
})
