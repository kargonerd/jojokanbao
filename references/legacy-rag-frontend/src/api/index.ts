import type {
  AdminAccount,
  ChatReference,
  ChatResponse,
  Notebook,
  PersonEvents,
  PersonSummary,
  RelationsGraph,
  Source,
  SourceDocument,
  TimelineEvent,
} from '../types'

interface ApiEnvelope<T = unknown> {
  success: boolean
  data?: T
  error?: string
  [key: string]: unknown
}

export function resolveBackendUrl(path: string) {
  const configuredOrigin = import.meta.env.VITE_BACKEND_ORIGIN
  if (configuredOrigin) {
    return `${configuredOrigin}${path}`
  }
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname || '127.0.0.1'
    const isLocalDevHost = hostname === '127.0.0.1' || hostname === 'localhost'
    const isViteDevPort = /^30\d\d$/.test(window.location.port)
    if (isLocalDevHost && isViteDevPort) {
      return `http://${hostname}:9002${path}`
    }
  }
  return path
}

function withAdminAuth() {
  const token = localStorage.getItem('admin_token')
  const headers: Record<string, string> = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  const text = await response.text()
  if (!text) {
    return { success: response.ok }
  }

  try {
    return JSON.parse(text) as ApiEnvelope<T>
  } catch {
    throw new Error(response.ok ? '响应格式错误' : `请求失败：${response.status}`)
  }
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  pick: (data: ApiEnvelope) => T = data => data.data as T,
) {
  const response = await fetch(resolveBackendUrl(path), init)
  const data = await readEnvelope(response)
  if (!response.ok || !data.success) {
    throw new Error(data.error || `请求失败：${response.status}`)
  }
  return pick(data)
}

function jsonInit(method: string, payload?: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }
}

function formInit(method: string, form: FormData, headers?: Record<string, string>): RequestInit {
  return {
    method,
    headers,
    body: form,
  }
}

export const notebookApi = {
  list(): Promise<Notebook[]> {
    return requestJson('/api/notebooks')
  },

  getSources(notebookId: string): Promise<Source[]> {
    return requestJson(`/api/notebooks/${notebookId}/sources`)
  },

  getSourceFulltext(notebookId: string, sourceId: string): Promise<SourceDocument> {
    return requestJson(`/api/notebooks/${notebookId}/sources/${sourceId}/fulltext`)
  },
}

export interface StreamCallbacks {
  onChunk: (chunk: string, references?: ChatReference[]) => void
  onDone: (conversationId: string, references: ChatReference[]) => void
  onError: (error: string) => void
}

export const chatApi = {
  ask(
    notebookId: string,
    question: string,
    conversationId?: string,
    sourceIds?: string[],
  ): Promise<ChatResponse> {
    return requestJson('/api/chat', jsonInit('POST', {
      notebook_id: notebookId,
      question,
      conversation_id: conversationId,
      source_ids: sourceIds,
    }))
  },

  async askStream(
    notebookId: string,
    question: string,
    conversationId: string | undefined,
    callbacks: StreamCallbacks,
    sourceIds?: string[],
  ): Promise<void> {
    const response = await fetch(resolveBackendUrl('/api/chat/stream'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        notebook_id: notebookId,
        question,
        conversation_id: conversationId,
        source_ids: sourceIds,
      }),
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    if (!response.body) {
      throw new Error('Response body is null')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue

          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            if (parsed.chunk !== undefined) {
              callbacks.onChunk(parsed.chunk, parsed.references)
            } else if (parsed.done) {
              callbacks.onDone(parsed.conversation_id, parsed.references || [])
              return
            } else if (parsed.error) {
              callbacks.onError(parsed.error)
              return
            }
          } catch {
            // Ignore incomplete streaming fragments.
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  },

  getHistory(notebookId: string, conversationId: string): Promise<{ messages: unknown[] }> {
    return requestJson(`/api/notebooks/${notebookId}/conversations/${conversationId}/history`)
  },
}

export const catalogApi = {
  listNotebooks(): Promise<Notebook[]> {
    return requestJson('/api/catalog/notebooks')
  },

  getNotebook(notebookId: string): Promise<Notebook & { sources: Source[] }> {
    return requestJson(`/api/catalog/notebooks/${notebookId}`)
  },

  getSourceDocument(notebookId: string, sourceId: string): Promise<SourceDocument> {
    return requestJson(`/api/catalog/notebooks/${notebookId}/sources/${sourceId}/document`)
  },

  getSourceChapter(notebookId: string, sourceId: string, chapterId: string): Promise<{ id: string; title: string; text: string; order?: number; summary?: string }> {
    return requestJson(`/api/catalog/notebooks/${notebookId}/sources/${sourceId}/chapters/${encodeURIComponent(chapterId)}`)
  },

  getPersons(notebookId: string, sourceId: string): Promise<PersonSummary[]> {
    return requestJson(`/api/catalog/notebooks/${notebookId}/sources/${sourceId}/analysis/persons`)
  },

  getPersonEvents(notebookId: string, sourceId: string, personName: string): Promise<PersonEvents> {
    return requestJson(`/api/catalog/notebooks/${notebookId}/sources/${sourceId}/analysis/persons/${encodeURIComponent(personName)}/events`)
  },

  getTimeline(notebookId: string, sourceId: string, query = ''): Promise<TimelineEvent[]> {
    return requestJson(
      `/api/catalog/notebooks/${notebookId}/sources/${sourceId}/analysis/timeline`,
      jsonInit('POST', { query }),
      data => ((data.data as { timeline?: TimelineEvent[] })?.timeline || []),
    )
  },

  getRelations(notebookId: string, sourceId: string, query = ''): Promise<RelationsGraph> {
    return requestJson(
      `/api/catalog/notebooks/${notebookId}/sources/${sourceId}/analysis/relations`,
      jsonInit('POST', { query }),
    )
  },
}

export const adminCatalogApi = {
  getAccounts(): Promise<AdminAccount[]> {
    return requestJson('/admin/config', { headers: withAdminAuth() }, data => (data.accounts as AdminAccount[]) || [])
  },

  addAccount(payload: { name: string; cookie: string }): Promise<AdminAccount[]> {
    return requestJson('/admin/accounts', jsonInit('POST', payload, withAdminAuth()), data => (data.accounts as AdminAccount[]) || [])
  },

  refreshAccount(accountId: number): Promise<AdminAccount[]> {
    return requestJson(`/admin/accounts/${accountId}/refresh`, { method: 'POST', headers: withAdminAuth() }, data => (data.accounts as AdminAccount[]) || [])
  },

  deleteAccount(accountId: number): Promise<AdminAccount[]> {
    return requestJson(`/admin/accounts/${accountId}`, { method: 'DELETE', headers: withAdminAuth() }, data => (data.accounts as AdminAccount[]) || [])
  },

  listNotebooks(): Promise<Notebook[]> {
    return requestJson('/admin/notebooks', { headers: withAdminAuth() }, data => (data.data as Notebook[]) || [])
  },

  updateNotebook(notebookId: string, payload: Record<string, unknown>): Promise<Notebook> {
    return requestJson(`/admin/notebooks/${notebookId}`, jsonInit('PUT', payload, withAdminAuth()))
  },

  uploadNotebookCover(notebookId: string, file: File): Promise<string> {
    const form = new FormData()
    form.append('file', file)
    return requestJson(`/admin/notebooks/${notebookId}/cover`, formInit('POST', form, withAdminAuth()), data => String(data.cover_url || ''))
  },

  listSources(notebookId: string): Promise<Source[]> {
    return requestJson(`/admin/notebooks/${notebookId}/sources`, { headers: withAdminAuth() }, data => (data.data as Source[]) || [])
  },

  updateSource(notebookId: string, sourceId: string, payload: Record<string, unknown>): Promise<Source> {
    return requestJson(`/admin/notebooks/${notebookId}/sources/${sourceId}`, jsonInit('PUT', payload, withAdminAuth()))
  },

  uploadSourceCover(notebookId: string, sourceId: string, file: File): Promise<string> {
    const form = new FormData()
    form.append('file', file)
    return requestJson(`/admin/notebooks/${notebookId}/sources/${sourceId}/cover`, formInit('POST', form, withAdminAuth()), data => String(data.cover_url || ''))
  },

  uploadSourceDocument(
    notebookId: string,
    sourceId: string,
    payload: {
      markdown: File
      pdf?: File
      title?: string
      assetManifest?: Array<Record<string, unknown>>
    },
  ): Promise<Source> {
    const form = new FormData()
    form.append('markdown', payload.markdown)
    if (payload.pdf) {
      form.append('pdf', payload.pdf)
    }
    if (payload.title) {
      form.append('title', payload.title)
    }
    if (payload.assetManifest) {
      form.append('asset_manifest', JSON.stringify(payload.assetManifest))
    }

    return requestJson(`/admin/notebooks/${notebookId}/sources/${sourceId}/document`, formInit('POST', form, withAdminAuth()))
  },

  importSourcePackage(notebookId: string, sourceId: string, file: File): Promise<Source> {
    const form = new FormData()
    form.append('package', file)
    return requestJson(`/admin/notebooks/${notebookId}/sources/${sourceId}/import-package`, formInit('POST', form, withAdminAuth()))
  },
}
