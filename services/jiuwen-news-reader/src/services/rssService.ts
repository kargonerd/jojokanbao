import type { RSSSource, NewsItem } from '@/types'
import { fetchSources, fetchNewsBySource } from './api'

// 获取 RSS 新闻（单个源）
export async function fetchRSSNews(source: RSSSource): Promise<NewsItem[]> {
  return fetchNewsBySource(source.id)
}

// 获取多个源的新闻
export async function fetchMultipleSources(sourceIds: string[]): Promise<NewsItem[]> {
  // 构建查询参数
  const queryParams = sourceIds.length > 0 ? `?sources=${sourceIds.join(',')}` : ''
  const response = await fetch(`/api/news${queryParams}`)
  if (!response.ok) throw new Error('Failed to fetch news')
  const data = await response.json()
  // 后端返回 { articles: [...], nextCursor, hasMore } 格式
  return data.articles || []
}

// 导出默认源（从后端获取）
export { fetchSources as getDefaultSources }
