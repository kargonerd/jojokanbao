import { ref } from 'vue'

export type ToastType = 'success' | 'error'

export interface ToastState {
  message: string
  type: ToastType
}

export function useToast(timeout = 3000) {
  const toast = ref<ToastState | null>(null)
  let timer: number | null = null

  function showToast(message: string, type: ToastType = 'success') {
    toast.value = { message, type }
    if (timer) {
      window.clearTimeout(timer)
    }
    timer = window.setTimeout(() => {
      toast.value = null
      timer = null
    }, timeout)
  }

  function clearToast() {
    if (timer) {
      window.clearTimeout(timer)
      timer = null
    }
    toast.value = null
  }

  return {
    toast,
    showToast,
    clearToast,
  }
}
