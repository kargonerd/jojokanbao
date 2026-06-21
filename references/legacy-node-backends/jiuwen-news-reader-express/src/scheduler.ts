import { fetchRSSNews, DEFAULT_SOURCES } from './rss.js'
import { initDatabase, upsertArticles, articleExists, logFetch } from './db.js'
import { identifyEvents } from './eventEngine.js'
import { batchIndexVectors } from './search.js'
import type { NewsItem } from './types.js'

// 抓取配置
const FETCH_CONFIG = {
  // 每次抓取间隔（分钟）
  intervalMinutes: 15,
  // 每个源最大抓取数量
  maxItemsPerSource: 100,
  // 并发数
  concurrency: 3,
  // 事件识别间隔（分钟）
  eventIdentificationIntervalMinutes: 30,
}

// 抓取状态
let isRunning = false
let lastFetchTime: Date | null = null

// 生成新闻ID
function generateNewsId(sourceId: string, link: string): string {
  // 使用链接的 hash 作为 ID 的一部分，确保去重
  const hash = Buffer.from(link).toString('base64').slice(0, 12)
  return `${sourceId}_${hash}`
}

// 抓取单个源
async function fetchSingleSource(source: typeof DEFAULT_SOURCES[0]): Promise<{
  success: boolean
  fetchedCount: number
  newCount: number
  error?: string
}> {
  const startedAt = new Date()

  try {
    console.log(`[Scheduler] 开始抓取: ${source.name}`)

    // 抓取新闻
    const news = await fetchRSSNews(source)
    const fetchedCount = news.length

    // 去重并生成ID
    const newArticles: NewsItem[] = []
    for (const item of news) {
      // 检查是否已存在（通过链接）
      if (articleExists(item.link)) {
        continue
      }

      // 生成唯一ID
      const id = generateNewsId(source.id, item.link)

      newArticles.push({
        ...item,
        id,
        sourceId: source.id,
        sourceName: source.name,
      })
    }

    // 批量插入
  const { success, failed } = upsertArticles(newArticles)
  const newCount = success

  // 索引向量
  if (newArticles.length > 0) {
    await batchIndexVectors(newArticles.map(a => ({
      id: a.id,
      title: a.title,
      content: a.content
    })))
  }

  const completedAt = new Date()

    // 记录日志
    logFetch({
      sourceId: source.id,
      sourceName: source.name,
      fetchedCount,
      newCount,
      errorMessage: failed > 0 ? `${failed} 条插入失败` : undefined,
      startedAt,
      completedAt,
    })

    console.log(`[Scheduler] ${source.name}: 抓取 ${fetchedCount} 条, 新增 ${newCount} 条`)

    return {
      success: true,
      fetchedCount,
      newCount,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const completedAt = new Date()

    logFetch({
      sourceId: source.id,
      sourceName: source.name,
      fetchedCount: 0,
      newCount: 0,
      errorMessage,
      startedAt,
      completedAt,
    })

    console.error(`[Scheduler] ${source.name} 抓取失败:`, errorMessage)

    return {
      success: false,
      fetchedCount: 0,
      newCount: 0,
      error: errorMessage,
    }
  }
}

// 分批并发抓取
async function fetchBatch(sources: typeof DEFAULT_SOURCES): Promise<void> {
  const { concurrency } = FETCH_CONFIG

  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency)
    await Promise.all(batch.map(source => fetchSingleSource(source)))

    // 批次间延迟，避免请求过快
    if (i + concurrency < sources.length) {
      await sleep(1000)
    }
  }
}

// 抓取所有源
export async function fetchAllSources(): Promise<{
  totalFetched: number
  totalNew: number
  errors: string[]
}> {
  if (isRunning) {
    console.log('[Scheduler] 抓取任务正在运行中，跳过')
    return { totalFetched: 0, totalNew: 0, errors: ['Task already running'] }
  }

  isRunning = true
  console.log('[Scheduler] 开始抓取所有源...')

  try {
    // 确保数据库已初始化
    initDatabase()

    const startTime = Date.now()
    const results = await Promise.all(
      DEFAULT_SOURCES.map(source => fetchSingleSource(source))
    )

    const totalFetched = results.reduce((sum, r) => sum + r.fetchedCount, 0)
    const totalNew = results.reduce((sum, r) => sum + r.newCount, 0)
    const errors = results.filter(r => r.error).map(r => r.error!)

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    lastFetchTime = new Date()

    console.log(`[Scheduler] 抓取完成: ${totalFetched} 条, 新增 ${totalNew} 条, 耗时 ${duration}s`)

    return { totalFetched, totalNew, errors }
  } catch (error) {
    console.error('[Scheduler] 抓取任务失败:', error)
    return {
      totalFetched: 0,
      totalNew: 0,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
    }
  } finally {
    isRunning = false
  }
}

// 启动定时任务
export function startScheduler(): void {
  console.log('[Scheduler] 启动定时抓取任务...')

  // 立即执行一次
  fetchAllSources()

  // 定时执行
  const intervalMs = FETCH_CONFIG.intervalMinutes * 60 * 1000
  setInterval(fetchAllSources, intervalMs)

  console.log(`[Scheduler] 每 ${FETCH_CONFIG.intervalMinutes} 分钟抓取一次`)
}

// 手动触发抓取
export async function manualFetch(): Promise<{
  totalFetched: number
  totalNew: number
  errors: string[]
}> {
  console.log('[Scheduler] 手动触发抓取')
  return fetchAllSources()
}

// 获取抓取状态
export function getSchedulerStatus(): {
  isRunning: boolean
  lastFetchTime: Date | null
  intervalMinutes: number
} {
  return {
    isRunning,
    lastFetchTime,
    intervalMinutes: FETCH_CONFIG.intervalMinutes,
  }
}

// 辅助函数
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
