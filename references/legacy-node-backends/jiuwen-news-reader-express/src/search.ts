import { initDatabase } from './db.js'
import { generateEmbedding, cosineSimilarity } from './embedding.js'
import type { NewsItem } from './types.js'
import * as sqliteVec from 'sqlite-vec'

const VECTOR_DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION || '1024')
const VEC_TABLE_NAME = `articles_vec_${VECTOR_DIMENSION}`

// 初始化搜索表
export function initSearch(): void {
  const db = initDatabase()
  
  // 加载 sqlite-vec 扩展
  sqliteVec.load(db)
  
  // 创建向量表（使用维度相关的表名，避免维度变化时冲突）
  // vec0 使用默认的 rowid 作为主键
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE_NAME} USING vec0(
      embedding float[${VECTOR_DIMENSION}]
    )
  `)
  
  // 创建 FTS5 虚拟表用于全文搜索（作为备选）
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
      title,
      content,
      content_row_id,
      content='articles',
      content_rowid='rowid'
    )
  `)
  
  // 创建触发器保持 FTS 索引同步
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(rowid, title, content)
      VALUES (new.rowid, new.title, new.content);
    END;
    
    CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, content)
      VALUES ('delete', old.rowid, old.title, old.content);
    END;
    
    CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, title, content)
      VALUES ('delete', old.rowid, old.title, old.content);
      INSERT INTO articles_fts(rowid, title, content)
      VALUES (new.rowid, new.title, new.content);
    END;
  `)
  
  console.log('[Search] 向量搜索索引初始化完成')
}

// 为新闻生成向量嵌入并存储
export async function indexArticleVector(articleId: string, title: string, content: string): Promise<void> {
  const db = initDatabase()
  
  try {
    // 生成嵌入向量
    const text = `${title} ${content || ''}`.slice(0, 1000)
    const embedding = await generateEmbedding(text)
    
    // 转换为 Float32Array
    const vector = new Float32Array(embedding)
    
    // 获取 rowid
    const rowStmt = db.prepare('SELECT rowid FROM articles WHERE id = ?')
    const row = rowStmt.get(articleId) as { rowid: number } | undefined
    
    if (!row) {
      console.warn(`[Search] 文章不存在: ${articleId}`)
      return
    }
    
    // 确保 rowid 是整数 - sqlite-vec 要求严格的整数类型
    const rowId = parseInt(row.rowid as any, 10)
    if (isNaN(rowId) || rowId <= 0) {
      console.warn(`[Search] 无效的 rowid: ${articleId}, rowid=${row.rowid}`)
      return
    }
    
    // 插入或更新向量
    try {
      // 先尝试删除旧记录
      db.exec(`DELETE FROM ${VEC_TABLE_NAME} WHERE rowid = ${rowId}`)
      
      // 插入新记录 - sqlite-vec 要求使用 rowid
      // 将向量转换为 JSON 字符串格式插入
      const vectorJson = JSON.stringify(Array.from(vector))
      db.exec(`INSERT INTO ${VEC_TABLE_NAME}(rowid, embedding) VALUES (${rowId}, vec_f32('${vectorJson}'))`)
    } catch (e) {
      console.error(`[Search] 插入向量失败: ${articleId}, rowid=${rowId}, type=${typeof rowId}`, e)
    }
    
  } catch (error) {
    console.error(`[Search] 索引文章向量失败: ${articleId}`, error)
  }
}

// 批量索引向量
export async function batchIndexVectors(articles: { id: string; title: string; content?: string }[]): Promise<void> {
  console.log(`[Search] 批量索引 ${articles.length} 篇文章的向量...`)
  
  for (const article of articles) {
    await indexArticleVector(article.id, article.title, article.content || '')
  }
  
  console.log(`[Search] 向量索引完成`)
}

// 向量搜索
export async function searchByVector(
  query: string,
  options: {
    limit?: number
    threshold?: number
  } = {}
): Promise<NewsItem[]> {
  const db = initDatabase()
  const { limit = 20, threshold = 0.3 } = options

  try {
    // 生成查询向量
    console.log(`[Search] 生成查询向量: "${query}"`)
    const queryEmbedding = await generateEmbedding(query)
    console.log(`[Search] 查询向量维度: ${queryEmbedding.length}`)
    const queryVector = new Float32Array(queryEmbedding)
    const vectorJson = JSON.stringify(Array.from(queryVector))

    // 先检查向量表中有多少数据
    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM ${VEC_TABLE_NAME}`)
    const { count } = countStmt.get() as { count: number }
    console.log(`[Search] 向量表中有 ${count} 条记录`)

    // 使用 sqlite-vec 进行向量搜索
    // 使用 vec_f32 函数将 JSON 转换为向量
    // sqlite-vec 要求使用 k = ? 约束来指定返回的最近邻数量
    console.log(`[Search] 执行向量搜索, limit=${limit}`)
    const stmt = db.prepare(`
      SELECT
        a.id, a.title, a.content, a.summary, a.link, a.pub_date as pubDate,
        a.source_id as sourceId, a.source_name as sourceName, a.icon, a.category, a.image_url as imageUrl,
        a.event_id as eventId,
        distance
      FROM ${VEC_TABLE_NAME} v
      JOIN articles a ON v.rowid = a.rowid
      WHERE v.embedding MATCH vec_f32(?)
        AND k = ?
      ORDER BY distance
      LIMIT ?
    `)

    const rows = stmt.all(vectorJson, limit, limit) as any[]
    console.log(`[Search] 向量搜索返回 ${rows.length} 条结果`)
    
    // 打印第一个结果的 distance
    if (rows.length > 0) {
      console.log(`[Search] 第一个结果 distance: ${rows[0].distance}, similarity: ${1 - (rows[0].distance / 2)}`)
    }

    // 过滤低相似度结果
    const filtered = rows.filter(row => {
      // distance 越小越相似，转换为相似度分数
      const similarity = 1 - (row.distance / 2)
      return similarity >= threshold
    })
    
    console.log(`[Search] 过滤后剩余 ${filtered.length} 条结果 (threshold=${threshold})`)

    return filtered.map(row => ({
      ...row,
      pubDate: row.pubDate,
      similarity: 1 - (row.distance / 2)
    }))

  } catch (error) {
    console.error('[Search] 向量搜索失败:', error)
    return []
  }
}

// 关键词搜索（FTS5）
export function searchByKeywords(
  keywords: string,
  options: {
    limit?: number
    offset?: number
    sourceId?: string
    publishedAfter?: string
    publishedBefore?: string
  } = {}
): { articles: NewsItem[]; total: number } {
  const db = initDatabase()
  
  const {
    limit = 20,
    offset = 0,
    sourceId,
    publishedAfter,
    publishedBefore
  } = options
  
  // 构建额外条件
  const conditions: string[] = []
  const params: any[] = []
  
  if (sourceId) {
    conditions.push('a.source_id = ?')
    params.push(sourceId)
  }
  
  if (publishedAfter) {
    conditions.push('a.pub_date > ?')
    params.push(publishedAfter)
  }
  
  if (publishedBefore) {
    conditions.push('a.pub_date < ?')
    params.push(publishedBefore)
  }
  
  const extraWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''
  
  // 使用 FTS5 搜索
  const searchQuery = keywords
    .split(/\s+/)
    .map(k => `${k}*`)
    .join(' ')
  
  // 获取总数
  const countStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM articles_fts fts
    JOIN articles a ON fts.rowid = a.rowid
    WHERE articles_fts MATCH ?
    ${extraWhere}
  `)
  
  const { count: total } = countStmt.get(searchQuery, ...params) as { count: number }
  
  // 获取结果
  const stmt = db.prepare(`
    SELECT 
      a.id, a.title, a.content, a.summary, a.link, a.pub_date as pubDate,
      a.source_id as sourceId, a.source_name as sourceName, a.icon, a.category, a.image_url as imageUrl,
      a.event_id as eventId,
      rank as relevance
    FROM articles_fts fts
    JOIN articles a ON fts.rowid = a.rowid
    WHERE articles_fts MATCH ?
    ${extraWhere}
    ORDER BY rank
    LIMIT ? OFFSET ?
  `)
  
  const rows = stmt.all(searchQuery, ...params, limit, offset) as any[]
  
  const articles: NewsItem[] = rows.map(row => ({
    ...row,
    pubDate: row.pubDate
  }))
  
  return { articles, total }
}

// 混合搜索（向量 + 关键词）
export async function hybridSearch(
  query: string,
  options: {
    limit?: number
    vectorWeight?: number
    keywordWeight?: number
  } = {}
): Promise<NewsItem[]> {
  const {
    limit = 20,
    vectorWeight = 0.7,
    keywordWeight = 0.3
  } = options
  
  // 并行执行两种搜索
  const [vectorResults, keywordResults] = await Promise.all([
    searchByVector(query, { limit: limit * 2 }),
    searchByKeywords(query, { limit: limit * 2 })
  ])
  
  // 合并结果并加权排序
  const scoredMap = new Map<string, { article: NewsItem; score: number }>()
  
  // 向量结果加权
  vectorResults.forEach((article, index) => {
    const score = vectorWeight * (1 - index / vectorResults.length)
    scoredMap.set(article.id, { article, score })
  })
  
  // 关键词结果加权
  keywordResults.articles.forEach((article, index) => {
    const keywordScore = keywordWeight * (1 - index / keywordResults.articles.length)
    const existing = scoredMap.get(article.id)
    if (existing) {
      existing.score += keywordScore
    } else {
      scoredMap.set(article.id, { article, score: keywordScore })
    }
  })
  
  // 排序并返回
  return Array.from(scoredMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.article)
}

// 获取热门关键词
export function getHotKeywords(limit: number = 20): { word: string; count: number }[] {
  const db = initDatabase()
  
  // 获取最近24小时的新闻标题
  const cutoffTime = new Date()
  cutoffTime.setHours(cutoffTime.getHours() - 24)
  
  const stmt = db.prepare(`
    SELECT title FROM articles
    WHERE pub_date > ?
    ORDER BY pub_date DESC
    LIMIT 1000
  `)
  
  const rows = stmt.all(cutoffTime.toISOString()) as { title: string }[]
  
  // 统计词频
  const wordCount: Record<string, number> = {}
  
  for (const row of rows) {
    const words = extractWords(row.title)
    for (const word of words) {
      wordCount[word] = (wordCount[word] || 0) + 1
    }
  }
  
  // 排序返回
  return Object.entries(wordCount)
    .map(([word, count]) => ({ word, count }))
    .filter(item => item.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

// 提取关键词
function extractWords(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  
  const words: string[] = []
  
  for (let i = 0; i < cleaned.length - 1; i++) {
    for (let len = 2; len <= 4 && i + len <= cleaned.length; len++) {
      const word = cleaned.slice(i, i + len)
      if (/^[\u4e00-\u9fa5]+$/.test(word) || /^[a-z]{4,}$/.test(word)) {
        words.push(word)
      }
    }
  }
  
  return [...new Set(words)]
}

// 为 Claude Code 提供搜索接口
export async function searchForClaude(query: string, limit: number = 20): Promise<string> {
  const results = await hybridSearch(query, { limit })
  
  if (results.length === 0) {
    return '数据库中未找到相关新闻。'
  }
  
  const formatted = results.map((article, index) => {
    return `[${index + 1}] ${article.title}
来源: ${article.sourceName}
时间: ${article.pubDate}
链接: ${article.link}
摘要: ${article.summary || article.content?.slice(0, 200) || '无摘要'}
---`
  }).join('\n\n')
  
  return `从数据库中找到 ${results.length} 条相关新闻:\n\n${formatted}`
}

// 重新索引所有文章（用于初始化）
export async function reindexAllArticles(): Promise<void> {
  const db = initDatabase()
  
  console.log('[Search] 开始重新索引所有文章...')
  
  const stmt = db.prepare(`
    SELECT id, title, content
    FROM articles
    ORDER BY pub_date DESC
  `)
  
  const articles = stmt.all() as { id: string; title: string; content: string }[]
  
  console.log(`[Search] 需要索引 ${articles.length} 篇文章`)
  
  // 批量处理
  const batchSize = 10
  for (let i = 0; i < articles.length; i += batchSize) {
    const batch = articles.slice(i, i + batchSize)
    await batchIndexVectors(batch)
    
    if (i + batchSize < articles.length) {
      await sleep(100) // 避免阻塞
    }
  }
  
  console.log('[Search] 重新索引完成')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
