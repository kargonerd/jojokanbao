import express from 'express'
import cors from 'cors'
import { fetchRSSNews, fetchAllNews, DEFAULT_SOURCES, preloadNews } from './rss.js'
import { extractEntities, generateTimeline } from './ai.js'
import { uploadImage } from './cos.js'
import { initDatabase, getArticles, getArticleById, getArticleStats, getRecentFetchLogs } from './db.js'
import { startScheduler, manualFetch, getSchedulerStatus } from './scheduler.js'
import { fetchAndStoreFolo, getFoloSetupInstructions } from './folo.js'
import { initSearch, searchByKeywords, searchByVector, hybridSearch, getHotKeywords, searchForClaude, reindexAllArticles } from './search.js'
import { identifyEvents, getActiveEventList, getEventNews } from './eventEngine.js'
import multer from 'multer'

const app = express()

// 中间件
app.use(cors())
app.use(express.json())

// 配置 multer 用于文件上传
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 限制 5MB
  },
  fileFilter: (req, file, cb) => {
    // 只允许图片文件
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('只允许上传图片文件'))
    }
  },
})

// 初始化数据库和搜索
initDatabase()
initSearch()

// 健康检查
app.get('/api/health', (req, res) => {
  const schedulerStatus = getSchedulerStatus()
  const stats = getArticleStats()
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: 'connected',
    articles: stats.total,
    scheduler: schedulerStatus
  })
})

// 获取 RSS 源列表
app.get('/api/sources', async (_req, res) => {
  try {
    res.json(DEFAULT_SOURCES)
  } catch (error) {
    console.error('获取新闻源失败:', error)
    res.status(500).json({ 
      error: 'Failed to fetch sources',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 获取新闻列表（支持分页）
app.get('/api/news', async (req, res) => {
  try {
    const {
      cursor,
      limit,
      sources,
      publishedAfter,
      publishedBefore
    } = req.query

    const options: any = {}
    
    if (cursor) options.cursor = cursor as string
    if (limit) options.limit = parseInt(limit as string, 10)
    if (sources) options.sourceId = (sources as string).split(',')[0] // 暂时只支持单个源筛选
    if (publishedAfter) options.publishedAfter = publishedAfter as string
    if (publishedBefore) options.publishedBefore = publishedBefore as string

    const result = getArticles(options)
    
    res.json({
      articles: result.articles,
      nextCursor: result.nextCursor,
      hasMore: !!result.nextCursor
    })
  } catch (error) {
    console.error('获取新闻失败:', error)
    res.status(500).json({ 
      error: 'Failed to fetch news',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 获取指定源的新闻（实时抓取）
app.get('/api/news/:sourceId', async (req, res) => {
  try {
    const { sourceId } = req.params
    const source = DEFAULT_SOURCES.find(s => s.id === sourceId)
    
    if (!source) {
      return res.status(404).json({ error: 'Source not found' })
    }
    
    const news = await fetchRSSNews(source)
    res.json(news)
  } catch (error) {
    console.error('获取新闻失败:', error)
    res.status(500).json({ 
      error: 'Failed to fetch news',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 获取单条新闻
app.get('/api/articles/:id', async (req, res) => {
  try {
    const { id } = req.params
    const article = getArticleById(id)
    
    if (!article) {
      return res.status(404).json({ error: 'Article not found' })
    }
    
    res.json(article)
  } catch (error) {
    console.error('获取文章失败:', error)
    res.status(500).json({ 
      error: 'Failed to fetch article',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 获取统计信息
app.get('/api/stats', async (_req, res) => {
  try {
    const stats = getArticleStats()
    const logs = getRecentFetchLogs(5)
    
    res.json({
      ...stats,
      recentLogs: logs
    })
  } catch (error) {
    console.error('获取统计失败:', error)
    res.status(500).json({ 
      error: 'Failed to fetch stats',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 手动触发抓取
app.post('/api/admin/fetch', async (_req, res) => {
  try {
    const result = await manualFetch()
    res.json({
      success: true,
      ...result
    })
  } catch (error) {
    console.error('手动抓取失败:', error)
    res.status(500).json({ 
      error: 'Failed to fetch',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 抓取 Folo 数据
app.post('/api/admin/fetch-folo', async (req, res) => {
  try {
    const { feedId, publishedAfter, limit } = req.body
    
    const result = await fetchAndStoreFolo({
      feedId,
      publishedAfter,
      limit
    })
    
    res.json({
      success: true,
      ...result
    })
  } catch (error) {
    console.error('抓取 Folo 失败:', error)
    res.status(500).json({ 
      error: 'Failed to fetch Folo',
      message: error instanceof Error ? error.message : 'Unknown error',
      setupInstructions: getFoloSetupInstructions()
    })
  }
})

// 获取 Folo 配置说明
app.get('/api/admin/folo-setup', (_req, res) => {
  res.json({
    instructions: getFoloSetupInstructions()
  })
})

// 搜索新闻
app.get('/api/search', async (req, res) => {
  try {
    const { q, type, limit, offset } = req.query
    
    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' })
    }
    
    const query = q as string
    const searchType = (type as string) || 'hybrid'
    const searchLimit = parseInt(limit as string, 10) || 20
    const searchOffset = parseInt(offset as string, 10) || 0
    
    let result
    
    switch (searchType) {
      case 'keyword':
        result = searchByKeywords(query, { limit: searchLimit, offset: searchOffset })
        res.json(result)
        break
      case 'vector':
        result = { articles: await searchByVector(query, { limit: searchLimit }), total: 0 }
        res.json(result)
        break
      case 'hybrid':
      default:
        result = { articles: await hybridSearch(query, { limit: searchLimit }), total: 0 }
        res.json(result)
        break
    }
  } catch (error) {
    console.error('搜索失败:', error)
    res.status(500).json({
      error: 'Search failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 获取热门关键词
app.get('/api/hot-keywords', async (_req, res) => {
  try {
    const keywords = getHotKeywords(20)
    res.json(keywords)
  } catch (error) {
    console.error('获取热门关键词失败:', error)
    res.status(500).json({
      error: 'Failed to get hot keywords',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 获取事件列表
app.get('/api/events', async (_req, res) => {
  try {
    const events = getActiveEventList()
    res.json(events)
  } catch (error) {
    console.error('获取事件列表失败:', error)
    res.status(500).json({
      error: 'Failed to get events',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 获取事件详情
app.get('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params
    const news = getEventNews(id)
    
    if (news.length === 0) {
      return res.status(404).json({ error: 'Event not found or no news' })
    }
    
    res.json({
      eventId: id,
      newsCount: news.length,
      articles: news
    })
  } catch (error) {
    console.error('获取事件详情失败:', error)
    res.status(500).json({
      error: 'Failed to get event details',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 手动触发事件识别
app.post('/api/admin/identify-events', async (_req, res) => {
  try {
    const result = await identifyEvents()
    res.json({
      success: true,
      ...result
    })
  } catch (error) {
    console.error('事件识别失败:', error)
    res.status(500).json({
      error: 'Failed to identify events',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 手动触发重新索引所有文章
app.post('/api/admin/reindex', async (_req, res) => {
  try {
    console.log('[API] 手动触发重新索引...')
    await reindexAllArticles()
    res.json({ success: true, message: 'Reindex completed' })
  } catch (error) {
    console.error('重新索引失败:', error)
    res.status(500).json({
      error: 'Reindex failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 为 Claude Code 提供搜索接口
app.post('/api/search-for-claude', async (req, res) => {
  try {
    const { query, limit } = req.body
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' })
    }
    
    const result = searchForClaude(query, limit || 20)
    
    // 返回纯文本格式，方便 Claude 处理
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.send(result)
  } catch (error) {
    console.error('Claude 搜索失败:', error)
    res.status(500).json({
      error: 'Search failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 抽取实体
app.post('/api/extract-entities', async (req, res) => {
  try {
    const { title, content } = req.body
    
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' })
    }
    
    const entities = await extractEntities(title, content)
    res.json(entities)
  } catch (error) {
    console.error('实体抽取失败:', error)
    res.status(500).json({ 
      error: 'Failed to extract entities',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 生成时间线
app.post('/api/generate-timeline', async (req, res) => {
  try {
    const { entityName, entityType } = req.body
    
    if (!entityName || !entityType) {
      return res.status(400).json({ error: 'Entity name and type are required' })
    }
    
    const timeline = await generateTimeline(entityName, entityType)
    res.json(timeline)
  } catch (error) {
    console.error('时间线生成失败:', error)
    res.status(500).json({ 
      error: 'Failed to generate timeline',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 上传头像图片
app.post('/api/upload-avatar', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的图片' })
    }

    // 检查 COS 配置
    if (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY || !process.env.COS_BUCKET) {
      return res.status(500).json({ 
        error: 'COS 配置不完整',
        message: '请配置 COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET 环境变量'
      })
    }

    const imageUrl = await uploadImage(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    )
    
    res.json({ 
      success: true,
      url: imageUrl 
    })
  } catch (error) {
    console.error('上传头像失败:', error)
    res.status(500).json({ 
      error: 'Failed to upload avatar',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

// 全局错误处理
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason)
})

// 启动服务器（使用固定端口）
const PORT = process.env.PORT || 4568
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`)
  console.log(`📰 RSS sources: ${DEFAULT_SOURCES.length} configured`)
  console.log(`💾 Database: SQLite (persistent storage)`)
  console.log(`⏰ Scheduler: Auto-fetch every 15 minutes`)
  
  // 启动定时任务
  startScheduler()
})
