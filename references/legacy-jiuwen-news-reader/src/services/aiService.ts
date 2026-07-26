import type { ExtractedEntity, TimelineEvent } from '@/types'
import { extractEntitiesAPI, generateTimelineAPI } from './api'

// 从新闻抽取实体
export async function extractEntitiesFromNews(
  title: string, 
  content: string
): Promise<ExtractedEntity[]> {
  return extractEntitiesAPI(title, content)
}

// 生成实体时间线
export async function generateTimeline(
  entityName: string,
  entityType: string
): Promise<TimelineEvent[]> {
  return generateTimelineAPI(entityName, entityType)
}

// 批量处理新闻实体抽取
export async function batchExtractEntities(
  newsItems: Array<{ id: string; title: string; content: string }>,
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, ExtractedEntity[]>> {
  const results = new Map<string, ExtractedEntity[]>()
  
  for (let i = 0; i < newsItems.length; i++) {
    const item = newsItems[i]
    try {
      const entities = await extractEntitiesFromNews(item.title, item.content)
      results.set(item.id, entities)
      
      if (onProgress) {
        onProgress(i + 1, newsItems.length)
      }
      
      // 添加延迟避免限流
      if (i < newsItems.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } catch (error) {
      console.error(`处理新闻 ${item.id} 失败:`, error)
      results.set(item.id, [])
    }
  }
  
  return results
}
