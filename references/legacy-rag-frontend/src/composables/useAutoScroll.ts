import { nextTick, type Ref, watch, type WatchSource } from 'vue'

export function useAutoScroll(container: Ref<HTMLElement | null>, shouldScrollStreaming: () => boolean) {
  async function scrollToBottom() {
    await nextTick()
    const element = container.value
    if (element) {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    }
  }

  function watchMessageScroll<T>(source: WatchSource<T>) {
    watch(source, scrollToBottom, { deep: true })
  }

  function watchStreamingScroll(source: Ref<string>) {
    watch(source, value => {
      if (value && shouldScrollStreaming()) {
        scrollToBottom()
      }
    })
  }

  return {
    scrollToBottom,
    watchMessageScroll,
    watchStreamingScroll,
  }
}
