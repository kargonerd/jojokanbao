import { spawn } from 'child_process'
import { initDatabase } from './db.js'
import type { NewsItem } from './types.js'

// 事件识别配置
const EVENT_CONFIG = {
  // 只处理最近24小时的新闻
  maxNewsAgeHours: 24,
  // 每次处理的最大新闻数
  batchSize: 50,
  // 置信度阈值
  confidenceThreshold: 0.75,
}

// 获取需要处理的新闻（最近24小时，未分组的新闻）
function getRecentUngroupedNews(): NewsItem[] {
  const db = initDatabase()
  
  const cutoffTime = new Date()
  cutoffTime.setHours(cutoffTime.getHours() - EVENT_CONFIG.maxNewsAgeHours)
  
  const stmt = db.prepare(`
    SELECT 
      id, title, content, summary, link, pub_date as pubDate,
      source_id as sourceId, source_name as sourceName
    FROM articles
    WHERE event_id IS NULL
      AND pub_date > ?
    ORDER BY pub_date DESC
    LIMIT ?
  `)
  
  const rows = stmt.all(cutoffTime.toISOString(), EVENT_CONFIG.batchSize) as any[]
  
  return rows.map(row => ({
    ...row,
    pubDate: row.pubDate
  }))
}

// 获取活跃事件（最近24小时有更新的）
function getActiveEvents(): { id: string; name: string; newsCount: number }[] {
  const db = initDatabase()
  
  const cutoffTime = new Date()
  cutoffTime.setHours(cutoffTime.getHours() - EVENT_CONFIG.maxNewsAgeHours)
  
  const stmt = db.prepare(`
    SELECT e.id, e.name, e.news_count as newsCount
    FROM events e
    JOIN event_news en ON e.id = en.event_id
    JOIN articles a ON en.news_id = a.id
    WHERE a.pub_date > ?
      AND e.status = 'active'
    GROUP BY e.id
    ORDER BY MAX(a.pub_date) DESC
    LIMIT 20
  `)
  
  return stmt.all(cutoffTime.toISOString()) as any[]
}

// 调用 Claude Code 进行事件识别
async function callClaudeForEventIdentification(
  news: NewsItem[],
  activeEvents: { id: string; name: string; newsCount: number }[]
): Promise<{
  assignments: { newsId: string; eventId: string; confidence: number }[]
  newEvents: { tempId: string; name: string; summary: string }[]
}> {
  const prompt = buildEventPrompt(news, activeEvents)
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      claude.kill()
      reject(new Error('Claude Code 调用超时'))
    }, 120000)
    
    const claude = spawn('bash', [
      '-c',
      `claude --print ${JSON.stringify(prompt)} < /dev/null`
    ], { timeout: 120000 })
    
    let output = ''
    let errorOutput = ''
    
    claude.stdout.on('data', (data) => {
      output += data.toString()
    })
    
    claude.stderr.on('data', (data) => {
      errorOutput += data.toString()
    })
    
    claude.on('close', (code) => {
      clearTimeout(timeout)
      
      if (code !== 0) {
        console.error('[EventEngine] Claude Code 错误:', errorOutput)
        reject(new Error(`Claude Code 退出码: ${code}`))
        return
      }
      
      try {
        // 提取 JSON 部分
        const jsonMatch = output.match(/\{[\s\S]*\}/)
        if (!jsonMatch) {
          throw new Error('无法从输出中提取 JSON')
        }
        
        const result = JSON.parse(jsonMatch[0])
        resolve(result)
      } catch (e) {
        console.error('[EventEngine] 解析 Claude 输出失败:', output)
        reject(e)
      }
    })
  })
}

// 构建提示词
function buildEventPrompt(
  news: NewsItem[],
  activeEvents: { id: string; name: string; newsCount: number }[]
): string {
  const newsList = news.map(n => ({
    id: n.id,
    title: n.title,
    summary: n.summary || n.content?.slice(0, 200) || '',
    source: n.sourceName,
    pubDate: n.pubDate
  }))
  
  const eventList = activeEvents.map(e => ({
    id: e.id,
    name: e.name,
    newsCount: e.newsCount
  }))
  
  return `你是一个新闻事件识别专家。请分析以下新闻，判断它们是否属于同一事件的不同报道。

活跃事件列表（最近24小时）：
${JSON.stringify(eventList, null, 2)}

待分类新闻（最近24小时）：
${JSON.stringify(newsList, null, 2)}

任务：
1. 将每条新闻匹配到最合适的活跃事件，或标记为新事件
2. 同一事件的不同媒体报道应该归为同一事件
3. 主题相似但具体事件不同的，应创建新事件

输出 JSON 格式：
{
  "assignments": [
    {
      "newsId": "新闻ID",
      "eventId": "匹配的事件ID 或 NEW_临时ID",
      "confidence": 0.85,
      "reason": "匹配理由"
    }
  ],
  "newEvents": [
    {
      "tempId": "NEW_001",
      "name": "事件名称（10字以内）",
      "summary": "事件摘要（50字以内）"
    }
  ]
}

规则：
1. 时间跨度超过24小时的新闻不能归为同一事件
2. 置信度 < 0.75 的匹配应创建新事件
3. 同一事件的不同媒体报道标题可能不同，但核心内容一致
4. 只返回24小时内的新闻分组，不要考虑历史事件`
}

// 保存事件识别结果
function saveEventResults(
  assignments: { newsId: string; eventId: string; confidence: number }[],
  newEvents: { tempId: string; name: string; summary: string }[]
): void {
  const db = initDatabase()
  
  // 插入新事件
  const insertEvent = db.prepare(`
    INSERT INTO events (id, name, description, first_seen_at, last_updated_at, news_count, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(id) DO UPDATE SET
      last_updated_at = excluded.last_updated_at,
      news_count = news_count + 1
  `)
  
  // 插入事件-新闻关联
  const insertRelation = db.prepare(`
    INSERT INTO event_news (event_id, news_id, relationship_type, confidence)
    VALUES (?, ?, 'primary', ?)
    ON CONFLICT(event_id, news_id) DO UPDATE SET
      confidence = excluded.confidence
  `)
  
  // 更新新闻的 event_id
  const updateArticle = db.prepare(`
    UPDATE articles SET event_id = ? WHERE id = ?
  `)
  
  const now = new Date().toISOString()
  
  // 先处理新事件
  for (const event of newEvents) {
    const eventId = event.tempId.replace('NEW_', `evt_${Date.now()}_`)
    insertEvent.run(
      eventId,
      event.name,
      event.summary,
      now,
      now,
      0
    )
    
    // 替换临时ID为真实ID
    for (const assignment of assignments) {
      if (assignment.eventId === event.tempId) {
        assignment.eventId = eventId
      }
    }
  }
  
  // 处理关联
  for (const assignment of assignments) {
    if (assignment.confidence >= EVENT_CONFIG.confidenceThreshold) {
      insertRelation.run(assignment.eventId, assignment.newsId, assignment.confidence)
      updateArticle.run(assignment.eventId, assignment.newsId)
    }
  }
  
  console.log(`[EventEngine] 保存结果: ${assignments.length} 条关联, ${newEvents.length} 个新事件`)
}

// 清理过期事件（超过1天的事件标记为归档）
function archiveOldEvents(): void {
  const db = initDatabase()
  
  const cutoffTime = new Date()
  cutoffTime.setHours(cutoffTime.getHours() - 24)
  
  const stmt = db.prepare(`
    UPDATE events
    SET status = 'archived'
    WHERE status = 'active'
      AND last_updated_at < ?
  `)
  
  const result = stmt.run(cutoffTime.toISOString())
  
  if (result.changes > 0) {
    console.log(`[EventEngine] 归档 ${result.changes} 个过期事件`)
  }
}

// 主函数：识别事件
export async function identifyEvents(): Promise<{
  processed: number
  newEvents: number
  errors: string[]
}> {
  console.log('[EventEngine] 开始事件识别...')
  
  try {
    // 1. 获取最近未分组的新闻
    const news = getRecentUngroupedNews()
    
    if (news.length === 0) {
      console.log('[EventEngine] 没有需要处理的新闻')
      return { processed: 0, newEvents: 0, errors: [] }
    }
    
    console.log(`[EventEngine] 待处理新闻: ${news.length} 条`)
    
    // 2. 获取活跃事件
    const activeEvents = getActiveEvents()
    console.log(`[EventEngine] 活跃事件: ${activeEvents.length} 个`)
    
    // 3. 调用 Claude Code 识别
    const result = await callClaudeForEventIdentification(news, activeEvents)
    
    // 4. 保存结果
    saveEventResults(result.assignments, result.newEvents)
    
    // 5. 清理过期事件
    archiveOldEvents()
    
    return {
      processed: news.length,
      newEvents: result.newEvents.length,
      errors: []
    }
  } catch (error) {
    console.error('[EventEngine] 事件识别失败:', error)
    return {
      processed: 0,
      newEvents: 0,
      errors: [error instanceof Error ? error.message : 'Unknown error']
    }
  }
}

// 获取事件列表（仅活跃事件）
export function getActiveEventList(): {
  id: string
  name: string
  description?: string
  newsCount: number
  lastUpdated: string
}[] {
  const db = initDatabase()
  
  const stmt = db.prepare(`
    SELECT 
      id, name, description, news_count as newsCount, last_updated_at as lastUpdated
    FROM events
    WHERE status = 'active'
    ORDER BY last_updated_at DESC
  `)
  
  return stmt.all() as any[]
}

// 获取事件相关新闻
export function getEventNews(eventId: string): NewsItem[] {
  const db = initDatabase()
  
  const stmt = db.prepare(`
    SELECT 
      a.id, a.title, a.content, a.summary, a.link, a.pub_date as pubDate,
      a.source_id as sourceId, a.source_name as sourceName, a.icon, a.category, a.image_url as imageUrl
    FROM articles a
    JOIN event_news en ON a.id = en.news_id
    WHERE en.event_id = ?
    ORDER BY a.pub_date DESC
  `)
  
  const rows = stmt.all(eventId) as any[]
  
  return rows.map(row => ({
    ...row,
    pubDate: row.pubDate
  }))
}
