import { onUnmounted, ref, watch, type Ref } from 'vue'

export function useRotatingLoadingText(active: Ref<boolean>, texts: string[], delay = 2400) {
  const loadingText = ref(texts[0] || '')
  let timer: number | null = null

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  watch(active, isActive => {
    stop()
    if (!isActive || texts.length === 0) {
      return
    }

    let index = 0
    loadingText.value = texts[0]
    timer = window.setInterval(() => {
      index = (index + 1) % texts.length
      loadingText.value = texts[index]
    }, delay)
  })

  onUnmounted(stop)

  return { loadingText }
}
