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
  entities?: ExtractedEntity[]
}

// 抽取的实体
export interface ExtractedEntity {
  id: string
  name: string
  type: 'person' | 'organization' | 'location' | 'policy' | 'event' | 'concept' | 'other'
  description?: string
  confidence: number
  context?: string
  mentionCount?: number
}

// 时间线事件
export interface TimelineEvent {
  id: string
  date: string
  title: string
  description: string
  sourceUrl?: string
  sourceTitle?: string
  sourceName?: string
}

// 实体详情（含时间线）
export interface EntityDetail extends ExtractedEntity {
  timeline: TimelineEvent[]
  firstMentionedAt?: string
  lastMentionedAt?: string
}

// 用户信息
export interface User {
  deviceId: string
  nickname?: string
  avatar?: string
  createdAt: string
}

// 阅读历史记录
export interface ReadHistoryItem {
  newsId: string
  newsTitle: string
  sourceName: string
  readAt: string
  readCount: number
}

// 收藏项目
export interface FavoriteItem {
  newsId: string
  newsTitle: string
  sourceName: string
  link: string
  favoritedAt: string
}

// 应用状态
export interface AppState {
  user: User | null
  selectedSourceId: string | null
  isLoading: boolean
  error: string | null
}
