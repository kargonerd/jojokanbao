import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import type { NewsItem, RSSSource } from './types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 数据库文件路径
const DB_PATH = path.join(__dirname, '../../data/news.db')

// 数据库连接
let db: Database.Database | null = null

// 初始化数据库
export function initDatabase(): Database.Database {
  if (db) return db

  // 确保数据目录存在
  const dataDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  // 创建表
  createTables()

  console.log('[DB] 数据库初始化完成:', DB_PATH)
  return db
}

// 创建表结构
function createTables() {
  if (!db) return

  // 新闻表
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      link TEXT NOT NULL,
      pub_date DATETIME NOT NULL,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      icon TEXT,
      category TEXT,
      image_url TEXT,
      event_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_articles_pub_date ON articles(pub_date DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_source_id ON articles(source_id);
    CREATE INDEX IF NOT EXISTS idx_articles_event_id ON articles(event_id);
    CREATE INDEX IF NOT EXISTS idx_articles_created_at ON articles(created_at DESC);
  `)

  // 事件表
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      first_seen_at DATETIME,
      last_updated_at DATETIME,
      news_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 事件-新闻关联表
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_news (
      event_id TEXT,
      news_id TEXT,
      relationship_type TEXT DEFAULT 'primary',
      confidence REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, news_id),
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (news_id) REFERENCES articles(id)
    )
  `)

  // 抓取日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS fetch_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT,
      source_name TEXT,
      fetched_count INTEGER DEFAULT 0,
      new_count INTEGER DEFAULT 0,
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  console.log('[DB] 表结构创建完成')
}

// 插入或更新新闻
export function upsertArticle(article: NewsItem): boolean {
  if (!db) return false

  try {
    const stmt = db.prepare(`
      INSERT INTO articles (
        id, title, content, summary, link, pub_date,
        source_id, source_name, icon, category, image_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        summary = excluded.summary,
        updated_at = CURRENT_TIMESTAMP
    `)

    stmt.run(
      article.id,
      article.title,
      article.content || null,
      article.summary || null,
      article.link,
      article.pubDate,
      article.sourceId,
      article.sourceName,
      article.icon || null,
      article.category || null,
      article.imageUrl || null
    )

    return true
  } catch (error) {
    console.error('[DB] 插入新闻失败:', error)
    return false
  }
}

// 批量插入新闻
export function upsertArticles(articles: NewsItem[]): { success: number; failed: number } {
  if (!db) return { success: 0, failed: 0 }

  let success = 0
  let failed = 0

  const insert = db.transaction((items: NewsItem[]) => {
    for (const article of items) {
      if (upsertArticle(article)) {
        success++
      } else {
        failed++
      }
    }
  })

  insert(articles)
  return { success, failed }
}

// 获取新闻列表（支持分页）
export function getArticles(options: {
  cursor?: string
  limit?: number
  sourceId?: string
  eventId?: string
  publishedAfter?: string
  publishedBefore?: string
} = {}): { articles: NewsItem[]; nextCursor?: string } {
  if (!db) return { articles: [] }

  const {
    cursor,
    limit = 20,
    sourceId,
    eventId,
    publishedAfter,
    publishedBefore
  } = options

  let whereClause = 'WHERE 1=1'
  const params: any[] = []

  if (cursor) {
    whereClause += ' AND pub_date < ?'
    params.push(cursor)
  }

  if (sourceId) {
    whereClause += ' AND source_id = ?'
    params.push(sourceId)
  }

  if (eventId) {
    whereClause += ' AND event_id = ?'
    params.push(eventId)
  }

  if (publishedAfter) {
    whereClause += ' AND pub_date > ?'
    params.push(publishedAfter)
  }

  if (publishedBefore) {
    whereClause += ' AND pub_date < ?'
    params.push(publishedBefore)
  }

  const stmt = db.prepare(`
    SELECT 
      id, title, content, summary, link, pub_date as pubDate,
      source_id as sourceId, source_name as sourceName, icon, category, image_url as imageUrl,
      event_id as eventId
    FROM articles
    ${whereClause}
    ORDER BY pub_date DESC
    LIMIT ?
  `)

  params.push(limit + 1) // 多取一条用于判断是否有下一页

  const rows = stmt.all(...params) as any[]

  const articles: NewsItem[] = rows.slice(0, limit).map(row => ({
    ...row,
    pubDate: row.pubDate
  }))

  const nextCursor = rows.length > limit ? rows[limit - 1].pubDate : undefined

  return { articles, nextCursor }
}

// 获取单条新闻
export function getArticleById(id: string): NewsItem | null {
  if (!db) return null

  const stmt = db.prepare(`
    SELECT 
      id, title, content, summary, link, pub_date as pubDate,
      source_id as sourceId, source_name as sourceName, icon, category, image_url as imageUrl,
      event_id as eventId
    FROM articles
    WHERE id = ?
  `)

  const row = stmt.get(id) as any
  if (!row) return null

  return {
    ...row,
    pubDate: row.pubDate
  }
}

// 检查新闻是否已存在
export function articleExists(link: string): boolean {
  if (!db) return false

  const stmt = db.prepare('SELECT 1 FROM articles WHERE link = ?')
  const result = stmt.get(link)
  return !!result
}

// 获取新闻统计
export function getArticleStats(): { total: number; bySource: Record<string, number> } {
  if (!db) return { total: 0, bySource: {} }

  const totalStmt = db.prepare('SELECT COUNT(*) as count FROM articles')
  const { count: total } = totalStmt.get() as { count: number }

  const bySourceStmt = db.prepare(`
    SELECT source_name as source, COUNT(*) as count
    FROM articles
    GROUP BY source_name
    ORDER BY count DESC
  `)
  const bySourceRows = bySourceStmt.all() as { source: string; count: number }[]

  const bySource: Record<string, number> = {}
  for (const row of bySourceRows) {
    bySource[row.source] = row.count
  }

  return { total, bySource }
}

// 记录抓取日志
export function logFetch(options: {
  sourceId: string
  sourceName: string
  fetchedCount: number
  newCount: number
  errorMessage?: string
  startedAt: Date
  completedAt: Date
}): void {
  if (!db) return

  const stmt = db.prepare(`
    INSERT INTO fetch_logs (
      source_id, source_name, fetched_count, new_count,
      error_message, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    options.sourceId,
    options.sourceName,
    options.fetchedCount,
    options.newCount,
    options.errorMessage || null,
    options.startedAt.toISOString(),
    options.completedAt.toISOString()
  )
}

// 获取最近抓取日志
export function getRecentFetchLogs(limit: number = 10): any[] {
  if (!db) return []

  const stmt = db.prepare(`
    SELECT * FROM fetch_logs
    ORDER BY created_at DESC
    LIMIT ?
  `)

  return stmt.all(limit)
}

// 关闭数据库
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    console.log('[DB] 数据库连接已关闭')
  }
}
