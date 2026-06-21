import type { Message, Source } from '../types'

export const MESSAGES_KEY_PREFIX = 'notebooklm_messages_'
export const SOURCES_KEY_PREFIX = 'notebooklm_sources_'

export interface StoredMessages {
  messages: Message[]
  conversationId: string | null
}

export function saveMessages(notebookId: string, value: Message[], currentConversationId: string | null, storage: Storage = localStorage) {
  storage.setItem(
    MESSAGES_KEY_PREFIX + notebookId,
    JSON.stringify({
      conversationId: currentConversationId,
      messages: value.map(item => ({
        ...item,
        timestamp: item.timestamp.toISOString(),
      })),
    }),
  )
}

export function loadMessages(notebookId: string, storage: Storage = localStorage): StoredMessages {
  try {
    const raw = storage.getItem(MESSAGES_KEY_PREFIX + notebookId)
    if (!raw) {
      return { messages: [], conversationId: null }
    }

    const parsed = JSON.parse(raw)
    return {
      conversationId: parsed.conversationId || null,
      messages: (parsed.messages || []).map((item: Message & { timestamp: string }) => ({
        ...item,
        timestamp: new Date(item.timestamp),
      })),
    }
  } catch {
    return { messages: [], conversationId: null }
  }
}

export function clearMessages(notebookId: string, storage: Storage = localStorage) {
  storage.removeItem(MESSAGES_KEY_PREFIX + notebookId)
}

export function saveSources(notebookId: string, value: Source[], storage: Storage = localStorage) {
  storage.setItem(SOURCES_KEY_PREFIX + notebookId, JSON.stringify(value))
}

export function loadSources(notebookId: string, storage: Storage = localStorage): Source[] | null {
  try {
    const raw = storage.getItem(SOURCES_KEY_PREFIX + notebookId)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function findLatestNotebookWithMessages(storage: Storage = localStorage) {
  let latestId: string | null = null
  let latestTimestamp = 0

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(MESSAGES_KEY_PREFIX)) {
      continue
    }

    try {
      const raw = storage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      const items = parsed.messages || []
      if (!items.length) continue
      const timestamp = new Date(items[items.length - 1].timestamp).getTime()
      if (timestamp > latestTimestamp) {
        latestTimestamp = timestamp
        latestId = key.slice(MESSAGES_KEY_PREFIX.length)
      }
    } catch {
      continue
    }
  }

  return latestId
}
