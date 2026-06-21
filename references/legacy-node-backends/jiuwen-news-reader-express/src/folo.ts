import type { NewsItem } from './types.js'
import { upsertArticles } from './db.js'

// Folo API 配置
const FOLO_API_BASE = 'https://api.folo.is'

// Folo 源配置（从用户提供的 curl 分析）
export const FOLO_SOURCES: { id: string; name: string; feedId: string; category: string }[] = [
  // 这些 feedId 需要从 Folo 获取，这里先占位
  // 用户可以通过浏览器开发者工具获取自己的 feedId
]

// 从 Folo API 获取条目
export async function fetchFoloEntries(options: {
  feedId?: string
  publishedAfter?: string
  limit?: number
} = {}): Promise<NewsItem[]> {
  const { feedId, publishedAfter, limit = 50 } = options

  try {
    // 构建请求体
    const body: any = {
      view: 0, // 0 = 全部, 1 = 未读, 2 = 收藏
    }

    if (feedId) {
      body.feedId = feedId
    }

    if (publishedAfter) {
      body.publishedAfter = publishedAfter
    }

    console.log('[Folo] 请求参数:', body)

    // 注意：Folo API 需要认证，这里提供的是示例实现
    // 实际使用时需要用户提供 session token 或使用其他认证方式
    const response = await fetch(`${FOLO_API_BASE}/entries`, {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'X-App-Name': 'Folo Web',
        'X-App-Platform': 'desktop/web',
        'X-App-Version': '1.6.1',
        // 注意：以下需要从浏览器获取真实的认证信息
        // 'Cookie': '...',
        // 'X-Client-Id': '...',
        // 'X-Session-Id': '...',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data = await response.json()

    // 转换 Folo 格式为 NewsItem
    const entries = Array.isArray(data) ? data : data.data || []

    return entries.map((entry: any): NewsItem => ({
      id: `folo_${entry.id}`,
      title: entry.title || '无标题',
      content: entry.content || entry.description || '',
      summary: (entry.description || entry.content || '').slice(0, 200),
      link: entry.url || entry.link || '',
      pubDate: entry.publishedAt || entry.pubDate || new Date().toISOString(),
      sourceId: `folo_${entry.feedId || 'unknown'}`,
      sourceName: entry.feed?.title || 'Folo',
      icon: '📰',
      category: 'Folo',
      imageUrl: entry.media?.[0]?.url || entry.image,
    }))
  } catch (error) {
    console.error('[Folo] 抓取失败:', error)
    return []
  }
}

// 抓取 Folo 并存储
export async function fetchAndStoreFolo(options: {
  feedId?: string
  publishedAfter?: string
  limit?: number
} = {}): Promise<{ fetched: number; new: number }> {
  console.log('[Folo] 开始抓取...')

  const entries = await fetchFoloEntries(options)

  if (entries.length === 0) {
    return { fetched: 0, new: 0 }
  }

  // 去重并存储
  const { success } = upsertArticles(entries)

  console.log(`[Folo] 抓取 ${entries.length} 条, 存储 ${success} 条`)

  return {
    fetched: entries.length,
    new: success,
  }
}

// 获取 Folo 订阅列表
export async function fetchFoloSubscriptions(): Promise<any[]> {
  try {
    const response = await fetch(`${FOLO_API_BASE}/subscriptions`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-App-Name': 'Folo Web',
        'X-App-Platform': 'desktop/web',
        'X-App-Version': '1.6.1',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data = await response.json()
    return Array.isArray(data) ? data : data.data || []
  } catch (error) {
    console.error('[Folo] 获取订阅列表失败:', error)
    return []
  }
}

// 说明：Folo API 抓取需要用户认证信息
export function getFoloSetupInstructions(): string {
  return `
Folo 数据抓取需要认证信息，请按以下步骤获取：

1. 打开浏览器，登录 Folo (https://app.folo.is)
2. 按 F12 打开开发者工具
3. 切换到 Network (网络) 标签
4. 刷新页面，找到任意一个请求 (如 /entries)
5. 在请求头中找到以下信息：
   - Cookie 中的 __Secure-better-auth.session_token
   - X-Client-Id
   - X-Session-Id

6. 将获取的信息配置到环境变量：
   FOLO_SESSION_TOKEN=...
   FOLO_CLIENT_ID=...
   FOLO_SESSION_ID=...

或者直接在代码中修改 folo.ts 文件中的 headers。

注意：Folo API 是私有 API，使用时请遵守相关服务条款。
`
}
