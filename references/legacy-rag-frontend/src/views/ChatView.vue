<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ChatComposer from '../components/chat/ChatComposer.vue'
import MessageBubble from '../components/chat/MessageBubble.vue'
import ChatSidebar from '../components/chat/ChatSidebar.vue'
import SourceDialog from '../components/chat/SourceDialog.vue'
import { useAutoScroll } from '../composables/useAutoScroll'
import { useRotatingLoadingText } from '../composables/useRotatingLoadingText'
import {
  notebooks,
  selectedNotebook,
  sources,
  selectedSourceIds,
  messages,
  inputMessage,
  loading,
  loadingNotebooks,
  showSourceDialog,
  selectedSource,
  sourceFulltext,
  loadingSource,
  conversationId,
  streamingContent,
  streamingReferences,
  selectNotebook,
  sendMessage,
  clearConversation,
  openSourceDialog,
  showReference,
  initializeChatFromUrl,
  toggleSourceSelection,
  selectAllSources,
} from '../composables/useChat'
import type { ChatReference, Message } from '../types'

const currentConversationId = conversationId
const mainContentRef = ref<HTMLElement | null>(null)
const copiedMessageId = ref<string | null>(null)
const showShareToast = ref(false)

const { loadingText } = useRotatingLoadingText(loading, [
  '正在理解您的问题...',
  '正在检索相关资料...',
  '正在组织回答...',
  '正在补全引用...',
])
const autoScroll = useAutoScroll(mainContentRef, () => loading.value)
autoScroll.watchMessageScroll(messages)
autoScroll.watchStreamingScroll(streamingContent)

onMounted(() => {
  initializeChatFromUrl()
})

function handleSend() {
  sendMessage()
}

function handleCitation(reference: ChatReference) {
  showReference(reference)
}

async function copyMessage(message: Message) {
  await navigator.clipboard.writeText(message.content)
  copiedMessageId.value = message.id
  setTimeout(() => {
    copiedMessageId.value = null
  }, 1600)
}

function shareConversation() {
  if (!currentConversationId.value || !selectedNotebook.value) {
    return
  }

  const url = new URL(window.location.href)
  url.searchParams.set('notebook', selectedNotebook.value.id)
  url.searchParams.set('conversation', currentConversationId.value)
  navigator.clipboard.writeText(url.toString()).then(() => {
    showShareToast.value = true
    setTimeout(() => {
      showShareToast.value = false
    }, 2500)
  })
}
</script>

<template>
  <div class="chat-page">
    <ChatSidebar
      :notebooks="notebooks"
      :selected-notebook="selectedNotebook"
      :sources="sources"
      :selected-source-ids="selectedSourceIds"
      :loading-notebooks="loadingNotebooks"
      @select-notebook="selectNotebook"
      @select-source="toggleSourceSelection"
      @open-source="openSourceDialog"
      @select-all-sources="selectAllSources"
    />

    <main class="main-panel">
      <header class="main-header">
        <div v-if="selectedNotebook" class="header-copy">
          <div class="eyebrow">Notebook Chat</div>
          <h2>{{ selectedNotebook.title }}</h2>
          <p>{{ selectedSourceIds.length }} / {{ sources.length }} 个 source 已启用</p>
        </div>
        <div v-else class="header-copy">
          <div class="eyebrow">Notebook Chat</div>
          <h2>选择一个 notebook 开始对话</h2>
          <p>左侧文库和 source 会作为当前问答上下文。</p>
        </div>

        <div class="header-actions">
          <button
            v-if="currentConversationId && messages.length > 0"
            class="header-btn"
            type="button"
            @click="shareConversation"
          >
            分享对话
          </button>
          <button class="header-btn primary" type="button" @click="clearConversation">
            新对话
          </button>
        </div>
      </header>

      <div v-if="selectedNotebook" ref="mainContentRef" class="chat-panel">
        <div v-if="messages.length === 0 && !loading" class="empty-state">
          <h3>开始提问</h3>
          <p>你可以先勾选 source 范围，再围绕当前 notebook 发问。</p>
        </div>

        <MessageBubble
          v-for="message in messages"
          :key="message.id"
          :message="message"
          :copied="copiedMessageId === message.id"
          @copy="copyMessage"
          @citation="handleCitation"
        />

        <MessageBubble
          v-if="loading && streamingContent"
          role="assistant"
          :content="streamingContent"
          :references="streamingReferences"
          @citation="handleCitation"
        />

        <MessageBubble v-else-if="loading" role="assistant" :loading-text="loadingText" />
      </div>

      <div v-else class="empty-main">
        <h3>请先从左侧选择一个 notebook</h3>
      </div>

      <ChatComposer
        v-model="inputMessage"
        :disabled="!selectedNotebook || !inputMessage.trim() || loading"
        @send="handleSend"
      />
    </main>

    <SourceDialog
      v-if="showSourceDialog"
      :source="selectedSource"
      :content="sourceFulltext"
      :loading="loadingSource"
      @close="showSourceDialog = false"
    />

    <div v-if="showShareToast" class="share-toast">对话链接已复制</div>
  </div>
</template>

<style scoped>
.chat-page {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
}

.main-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 100vh;
}

.main-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 26px 30px 22px;
}

.eyebrow {
  margin-bottom: 6px;
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.header-copy h2 {
  font-size: 32px;
  line-height: 1.15;
}

.header-copy p {
  margin-top: 10px;
  color: var(--text-secondary);
}

.header-actions {
  display: flex;
  gap: 10px;
}

.header-btn {
  border: none;
  border-radius: 0;
  padding: 12px 18px;
  background: rgba(255, 255, 255, 0.82);
  color: var(--text-primary);
  box-shadow: none;
  font-weight: 700;
  cursor: pointer;
}

.header-btn.primary {
  background: var(--primary-color);
  color: #fff;
  box-shadow: none;
}

.chat-panel,
.empty-main {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 30px 20px;
}

.empty-state,
.empty-main {
  display: grid;
  place-items: center;
  align-content: center;
  text-align: center;
  color: var(--text-secondary);
}

.empty-mark {
  margin-bottom: 16px;
  color: var(--primary-color);
  font-weight: 800;
  letter-spacing: 0.08em;
  background: transparent;
  border: none;
}

.share-toast {
  color: var(--text-secondary);
}

.share-toast {
  position: fixed;
  right: 22px;
  bottom: 22px;
  padding: 12px 16px;
  border-radius: 0;
  background: var(--primary-color);
  border: 1px solid var(--border-strong);
  color: #fff;
}

@media (max-width: 1024px) {
  .chat-page {
    height: auto;
    grid-template-columns: 1fr;
  }

  .main-header,
  .chat-panel,
  .empty-main {
    padding-left: 18px;
    padding-right: 18px;
  }

  .main-header {
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .header-copy h2 {
    font-size: 24px;
  }

}
</style>
