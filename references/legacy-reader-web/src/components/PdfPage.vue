<template>
  <div><canvas ref="canvas"></canvas></div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import type { PDFDocumentProxy } from '@/pdfjs'

const props = defineProps<{
  source: PDFDocumentProxy
  page: number
  scale?: number
}>()

const emit = defineEmits<{
  rendered: []
  'rendering-failed': [error: unknown]
}>()

const canvas = ref<HTMLCanvasElement>()

async function renderPage() {
  try {
    const pdfPage = await props.source.getPage(props.page)
    const viewport = pdfPage.getViewport({ scale: props.scale ?? 2 })
    const el = canvas.value!
    el.width = viewport.width
    el.height = viewport.height
    await pdfPage.render({ canvasContext: el.getContext('2d')!, viewport }).promise
    emit('rendered')
  } catch (e) {
    console.error('PdfPage render error:', e)
    emit('rendering-failed', e)
  }
}

onMounted(renderPage)
watch(() => [props.source, props.page], renderPage)
</script>

<style>
canvas {
  display: block;
  width: 100% !important;
  height: auto !important;
}
</style>
