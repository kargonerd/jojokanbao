import { ref } from 'vue'
import type { ChatReference, Message, Notebook, Source } from '../types'
import { chatApi, notebookApi } from '../api'
import { clearMessages, findLatestNotebookWithMessages, loadMessages, loadSources, saveMessages, saveSources } from '../utils/chatStorage'

export const notebooks = ref<Notebook[]>([])
export const selectedNotebook = ref<Notebook | null>(null)
export const sources = ref<Source[]>([])
export const selectedSourceIds = ref<string[]>([])
export const messages = ref<Message[]>([])
export const inputMessage = ref('')
export const loading = ref(false)
export const loadingNotebooks = ref(true)
export const conversationId = ref<string | null>(null)
export const showSourceDialog = ref(false)
export const selectedSource = ref<Source | null>(null)
export const sourceFulltext = ref('')
export const loadingSource = ref(false)
export const highlightedReference = ref<ChatReference | null>(null)
export const streamingContent = ref('')
export const streamingReferences = ref<ChatReference[]>([])


function syncSelectedSources() {
  selectedSourceIds.value = sources.value.map(item => item.id)
}

function resetStreamingState() {
  streamingContent.value = ''
  streamingReferences.value = []
}

function appendAssistantError() {
  messages.value.push({
    id: String(Date.now() + 1),
    role: 'assistant',
    content: '抱歉，生成回答时出错，请稍后重试。',
    timestamp: new Date(),
  })
}

function finishLoading() {
  resetStreamingState()
  loading.value = false
}

export function toggleSourceSelection(sourceId: string) {
  if (selectedSourceIds.value.includes(sourceId)) {
    if (selectedSourceIds.value.length === 1) {
      return
    }
    selectedSourceIds.value = selectedSourceIds.value.filter(id => id !== sourceId)
    return
  }

  selectedSourceIds.value = [...selectedSourceIds.value, sourceId]
}

export function selectAllSources() {
  syncSelectedSources()
}

export async function loadNotebooks() {
  loadingNotebooks.value = true
  try {
    notebooks.value = await notebookApi.list()
    if (!selectedNotebook.value && notebooks.value.length > 0) {
      const latestNotebookId = findLatestNotebookWithMessages()
      const notebook = notebooks.value.find(item => item.id === latestNotebookId) || notebooks.value[0]
      await selectNotebook(notebook)
    }
  } finally {
    loadingNotebooks.value = false
  }
}

export async function selectNotebook(notebook: Notebook) {
  selectedNotebook.value = notebook
  const saved = loadMessages(notebook.id)
  messages.value = saved.messages
  conversationId.value = saved.conversationId

  const cachedSources = loadSources(notebook.id)
  if (cachedSources) {
    sources.value = cachedSources
    syncSelectedSources()
    return
  }

  try {
    sources.value = await notebookApi.getSources(notebook.id)
    saveSources(notebook.id, sources.value)
    syncSelectedSources()
  } catch {
    sources.value = []
    selectedSourceIds.value = []
  }
}

export async function sendMessage() {
  if (!selectedNotebook.value || loading.value || !inputMessage.value.trim()) {
    return
  }

  const question = inputMessage.value.trim()
  messages.value.push({
    id: String(Date.now()),
    role: 'user',
    content: question,
    timestamp: new Date(),
  })

  inputMessage.value = ''
  loading.value = true
  resetStreamingState()

  const sourceIds =
    selectedSourceIds.value.length === 0 || selectedSourceIds.value.length === sources.value.length
      ? undefined
      : selectedSourceIds.value

  try {
    await chatApi.askStream(
      selectedNotebook.value.id,
      question,
      conversationId.value || undefined,
      {
        onChunk(chunk, references) {
          streamingContent.value += chunk
          if (!references?.length) return

          streamingReferences.value = mergeReferences(streamingReferences.value, references)
        },
        onDone(newConversationId, references) {
          conversationId.value = newConversationId
          messages.value.push({
            id: String(Date.now() + 1),
            role: 'assistant',
            content: streamingContent.value,
            references,
            timestamp: new Date(),
          })
          finishLoading()

          if (selectedNotebook.value) {
            saveMessages(selectedNotebook.value.id, messages.value, conversationId.value)
          }
        },
        onError(error) {
          console.error('Stream error:', error)
          appendAssistantError()
          finishLoading()
        },
      },
      sourceIds,
    )
  } catch (error) {
    console.error('Failed to send message:', error)
    appendAssistantError()
    finishLoading()
  }
}

export function clearConversation() {
  if (selectedNotebook.value) {
    clearMessages(selectedNotebook.value.id)
  }
  messages.value = []
  conversationId.value = null
}

export async function openSourceDialog(source: Source) {
  if (!selectedNotebook.value) {
    return
  }

  selectedSource.value = source
  showSourceDialog.value = true
  loadingSource.value = true
  highlightedReference.value = null
  sourceFulltext.value = ''

  try {
    const payload = await notebookApi.getSourceFulltext(selectedNotebook.value.id, source.id)
    sourceFulltext.value = payload.text
  } catch {
    sourceFulltext.value = '无法加载文档内容。'
  } finally {
    loadingSource.value = false
  }
}

export function showReference(reference: ChatReference) {
  if (!selectedNotebook.value) {
    return
  }
  const source = sources.value.find(item => item.id === reference.source_id)
  if (!source) {
    return
  }

  const params = new URLSearchParams()
  if (reference.start_char !== null) {
    params.set('start', String(reference.start_char))
  }
  if (reference.end_char !== null) {
    params.set('end', String(reference.end_char))
  }
  if (reference.cited_text) {
    params.set('cited', reference.cited_text)
  }

  const query = params.toString()
  window.open(`/source/${selectedNotebook.value.id}/${source.id}${query ? `?${query}` : ''}`, '_blank')
}

export function mergeReferences(existingReferences: ChatReference[], incomingReferences: ChatReference[]) {
  const existing = new Set(existingReferences.map(item => item.citation_number))
  const merged = incomingReferences.filter(item => !existing.has(item.citation_number))
  return [...existingReferences, ...merged]
}

export async function initializeChatFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const notebookId = params.get('notebook')
  const currentConversationId = params.get('conversation')

  if (!notebookId || !currentConversationId) {
    await loadNotebooks()
    return
  }

  await loadNotebooks()
  const notebook = notebooks.value.find(item => item.id === notebookId)
  if (!notebook) {
    return
  }

  selectedNotebook.value = notebook
  conversationId.value = currentConversationId

  try {
    const payload = await chatApi.getHistory(notebookId, currentConversationId)
    messages.value = ((payload.messages || []) as Array<Message & { timestamp: string }>).map(item => ({
      ...item,
      timestamp: new Date(item.timestamp),
    }))
  } catch {
    const saved = loadMessages(notebookId)
    messages.value = saved.messages
    conversationId.value = saved.conversationId
  }

  const cachedSources = loadSources(notebookId)
  if (cachedSources) {
    sources.value = cachedSources
    syncSelectedSources()
  } else {
    try {
      sources.value = await notebookApi.getSources(notebookId)
      saveSources(notebookId, sources.value)
      syncSelectedSources()
    } catch {
      sources.value = []
      selectedSourceIds.value = []
    }
  }

  window.history.replaceState({}, '', window.location.pathname)
}

