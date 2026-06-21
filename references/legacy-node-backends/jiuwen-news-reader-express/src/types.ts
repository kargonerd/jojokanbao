// RSS 源配置
export interface RSSSource {
  id: string
  name: string
  url: string
  category: string
  description?: string
  icon?: string
  country?: string
}

// 新闻条目
export interface NewsItem {
  id: string
  title: string
  content: string
  summary?: string
  link: string
  pubDate: string
  sourceId: string
  sourceName: string
  icon?: string
  category?: string
  imageUrl?: string
}

// 抽取的实体
export interface ExtractedEntity {
  id: string
  name: string
  type: 'person' | 'organization' | 'location' | 'policy' | 'event' | 'concept' | 'other'
  description?: string
  confidence: number
  context?: string
}

// 时间线事件
export interface TimelineEvent {
  id: string
  date: string
  title: string
  description: string
  sourceUrl?: string
  sourceTitle?: string
}
