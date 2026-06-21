<script setup lang="ts">
import { formatMessageMarkdown } from '../../utils/markdown'
import type { Source } from '../../types'

defineProps<{
  source: Source | null
  content: string
  loading: boolean
}>()

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <div class="dialog-mask" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h3>{{ source?.title }}</h3>
        <button class="close-btn" type="button" @click="emit('close')">×</button>
      </div>
      <div class="dialog-content">
        <div v-if="loading" class="dialog-state">加载中...</div>
        <div v-else class="markdown-body" v-html="formatMessageMarkdown(content)"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-mask {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 30px;
  background: rgba(14, 10, 10, 0.42);
}

.dialog {
  width: min(960px, 100%);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  border-radius: 0;
  background: var(--bg-card);
  overflow: hidden;
  border: 1px solid var(--border-strong);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-color);
}

.close-btn {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 28px;
  cursor: pointer;
}

.dialog-content {
  overflow: auto;
  padding: 22px;
}

.dialog-state {
  color: var(--text-secondary);
}
</style>
