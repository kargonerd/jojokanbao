<script setup lang="ts">
import { computed } from 'vue'
import { formatMessageMarkdown } from '../../utils/markdown'
import type { ChatReference, Message } from '../../types'

const props = defineProps<{
  message?: Message
  content?: string
  references?: ChatReference[]
  role?: Message['role']
  copied?: boolean
  loadingText?: string
}>()

const emit = defineEmits<{
  copy: [message: Message]
  citation: [reference: ChatReference]
}>()

const displayRole = computed(() => props.message?.role || props.role || 'assistant')
const displayContent = computed(() => props.message?.content || props.content || '')
const displayReferences = computed(() => props.message?.references || props.references)
const html = computed(() => formatMessageMarkdown(displayContent.value, displayReferences.value))

function handleCitationClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (!target.classList.contains('citation-link')) {
    return
  }

  event.preventDefault()
  const refNum = Number(target.getAttribute('data-ref') || '0')
  const reference = displayReferences.value?.find(item => item.citation_number === refNum)
  if (reference) {
    emit('citation', reference)
  }
}
</script>

<template>
  <article class="message" :class="displayRole">
    <div class="message-shell">
      <div class="message-tag">{{ displayRole === 'user' ? '你' : 'JOJO AI' }}</div>

      <div v-if="loadingText" class="typing-state">
        <span class="typing-dot"></span>
        <span>{{ loadingText }}</span>
      </div>

      <template v-else>
        <div
          class="message-body markdown-body"
          v-html="html"
          @click="handleCitationClick"
        ></div>
        <div v-if="message" class="message-footer">
          <button class="text-action" type="button" @click="emit('copy', message)">
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>
      </template>
    </div>
  </article>
</template>

<style scoped>
.message {
  display: flex;
  margin-bottom: 18px;
}

.message.user {
  justify-content: flex-end;
}

.message-shell {
  width: min(840px, 92%);
  padding: 18px 20px 16px;
  border-radius: 0;
  border: 1px solid rgba(158, 19, 27, 0.08);
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 18px 40px rgba(44, 24, 24, 0.06);
}

.message.user .message-shell {
  background: linear-gradient(180deg, #fff7f7 0%, #fff 100%);
  border-color: rgba(158, 19, 27, 0.14);
}

.message-tag {
  margin-bottom: 10px;
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.message-body :deep(p:last-child) {
  margin-bottom: 0;
}

.message-footer {
  margin-top: 12px;
}

.text-action {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.typing-state {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-secondary);
}

.typing-dot {
  width: 10px;
  height: 10px;
  border-radius: 0;
  background: var(--primary-color);
  animation: pulse 1s ease-in-out infinite;
}

:deep(.citation-link) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  margin: 0 2px;
  border-radius: 0;
  border: 1px solid var(--border-strong);
  background: rgba(158, 19, 27, 0.1);
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
}

@keyframes pulse {
  0%, 100% {
    opacity: 0.35;
    transform: scale(0.92);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (max-width: 640px) {
  .message-shell {
    width: 100%;
  }
}
</style>
