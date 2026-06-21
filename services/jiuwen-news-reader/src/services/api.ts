import type { RSSSource, NewsItem, ExtractedEntity, TimelineEvent } from '@/types'

const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api'

// 通用请求函数
async function fetchAPI<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }))
    throw new Error(error.message || `HTTP error! status: ${response.status}`)
  }
  
  return response.json()
}

// 获取所有RSS源
export async function fetchSources(): Promise<RSSSource[]> {
  return fetchAPI<RSSSource[]>('/sources')
}

// 获取指定源的新闻
export async function fetchNewsBySource(sourceId: string): Promise<NewsItem[]> {
  return fetchAPI<NewsItem[]>(`/news/${sourceId}`)
}

// 获取所有新闻
export async function fetchAllNews(): Promise<NewsItem[]> {
  return fetchAPI<NewsItem[]>('/news')
}

// 抽取实体
export async function extractEntitiesAPI(title: string, content: string): Promise<ExtractedEntity[]> {
  return fetchAPI<ExtractedEntity[]>('/extract-entities', {
    method: 'POST',
    body: JSON.stringify({ title, content }),
  })
}

// 生成时间线
export async function generateTimelineAPI(entityName: string, entityType: string): Promise<TimelineEvent[]> {
  return fetchAPI<TimelineEvent[]>('/generate-timeline', {
    method: 'POST',
    body: JSON.stringify({ entityName, entityType }),
  })
}
