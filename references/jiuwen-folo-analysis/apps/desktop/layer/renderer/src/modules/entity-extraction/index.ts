import { EntityService } from "@follow/database/services/entity"
import { extractEntitiesFromEntry } from "@follow/utils/entity-extraction"
import { generateTimeline } from "@follow/utils/timeline-generation"
import { getEntry } from "@follow/store/entry/getter"

import { appLog } from "~/lib/log"

/**
 * 实体抽取任务处理器
 * 负责从文章中抽取实体并生成时间线
 */

// 处理单个文章的实体抽取
export async function processEntityExtraction(entryId: string): Promise<void> {
  try {
    // 1. 检查是否已处理
    const existingJob = await EntityService.getJobByEntryId(entryId)
    if (existingJob?.status === "completed") {
      appLog(`[EntityExtraction] Entry ${entryId} already processed`)
      return
    }

    // 2. 创建或更新任务状态为处理中
    const jobId = existingJob?.id || await EntityService.createExtractionJob(entryId)
    await EntityService.updateJobStatus(jobId, "processing")

    // 3. 获取文章内容
    const entry = getEntry(entryId)
    if (!entry) {
      throw new Error(`Entry ${entryId} not found`)
    }

    const title = entry.title || ""
    const content = entry.content || ""

    if (!content) {
      appLog(`[EntityExtraction] Entry ${entryId} has no content`)
      await EntityService.updateJobStatus(jobId, "completed", {
        extractedEntities: [],
      })
      return
    }

    // 4. 抽取实体
    appLog(`[EntityExtraction] Extracting entities from entry ${entryId}`)
    const extractionResult = await extractEntitiesFromEntry(title, content)

    if (!extractionResult.success) {
      throw new Error(extractionResult.error || "Entity extraction failed")
    }

    // 5. 保存抽取结果
    await EntityService.processExtractionResult(entryId, extractionResult.entities)

    // 6. 更新任务状态为完成
    await EntityService.updateJobStatus(jobId, "completed", {
      extractedEntities: extractionResult.entities,
    })

    appLog(
      `[EntityExtraction] Successfully extracted ${extractionResult.entities.length} entities from entry ${entryId}`
    )

    // 7. 为每个实体生成时间线（异步，不阻塞）
    for (const entity of extractionResult.entities) {
      if (entity.type === "person" || entity.type === "organization" || entity.type === "event") {
        generateEntityTimeline(entity.name, entity.type).catch((error) => {
          appLog(`[EntityExtraction] Failed to generate timeline for ${entity.name}:`, error)
        })
      }
    }
  } catch (error) {
    appLog(`[EntityExtraction] Failed to process entry ${entryId}:`, error)

    // 更新任务状态为失败
    const existingJob = await EntityService.getJobByEntryId(entryId)
    if (existingJob) {
      await EntityService.updateJobStatus(existingJob.id, "failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

// 生成实体时间线
async function generateEntityTimeline(
  entityName: string,
  entityType: string
): Promise<void> {
  try {
    // 1. 获取或创建实体
    let entity = await EntityService.getEntityByNameAndType(entityName, entityType)

    if (!entity) {
      const entityId = await EntityService.upsertEntity({
        name: entityName,
        type: entityType as any,
        firstMentionedAt: Date.now(),
        lastMentionedAt: Date.now(),
        mentionCount: 0,
      })
      entity = await EntityService.getEntityById(entityId)
    }

    if (!entity) {
      throw new Error(`Failed to create or get entity ${entityName}`)
    }

    // 2. 检查时间线是否需要更新（7天内更新过则跳过）
    if (entity.timelineUpdatedAt) {
      const daysSinceUpdate = (Date.now() - entity.timelineUpdatedAt) / (1000 * 60 * 60 * 24)
      if (daysSinceUpdate < 7) {
        appLog(`[EntityExtraction] Timeline for ${entityName} is up to date`)
        return
      }
    }

    // 3. 搜索实体相关信息
    const searchResults = await searchEntityInfo(entityName, entityType)

    // 4. 生成时间线
    const timelineResult = await generateTimeline(entityName, entityType, searchResults)

    if (!timelineResult.success) {
      throw new Error(timelineResult.error || "Timeline generation failed")
    }

    // 5. 保存时间线事件
    await EntityService.addTimelineEvents(
      entity.id,
      timelineResult.events.map((event) => ({
        date: event.date,
        title: event.title,
        description: event.description,
        sourceUrl: event.sourceUrl,
        sourceTitle: event.sourceTitle,
      }))
    )

    // 6. 更新时间线缓存
    await EntityService.updateEntityTimelineCache(entity.id, timelineResult.events)

    appLog(
      `[EntityExtraction] Generated timeline for ${entityName} with ${timelineResult.events.length} events`
    )
  } catch (error) {
    appLog(`[EntityExtraction] Failed to generate timeline for ${entityName}:`, error)
    throw error
  }
}

// 搜索实体信息（模拟实现，实际应该调用搜索API）
async function searchEntityInfo(entityName: string, entityType: string): Promise<string> {
  // 这里应该调用实际的搜索API
  // 暂时返回空字符串，让AI基于已有知识生成时间线
  return `搜索关键词: ${entityName} (${entityType})`
}

// 处理待处理的任务队列
export async function processPendingJobs(limit: number = 5): Promise<void> {
  const pendingJobs = await EntityService.getPendingJobs(limit)

  if (pendingJobs.length === 0) {
    return
  }

  appLog(`[EntityExtraction] Processing ${pendingJobs.length} pending jobs`)

  for (const job of pendingJobs) {
    await processEntityExtraction(job.entryId)
  }
}

// 为所有未处理的文章创建抽取任务
export async function createJobsForUnprocessedEntries(
  entryIds: string[]
): Promise<void> {
  let createdCount = 0

  for (const entryId of entryIds) {
    const existingJob = await EntityService.getJobByEntryId(entryId)
    if (!existingJob) {
      await EntityService.createExtractionJob(entryId)
      createdCount++
    }
  }

  if (createdCount > 0) {
    appLog(`[EntityExtraction] Created ${createdCount} new extraction jobs`)
  }
}

// 启动定时任务
let extractionTimer: ReturnType<typeof setInterval> | null = null

export function startEntityExtractionScheduler(
  intervalMs: number = 60000 // 默认1分钟
): () => void {
  // 立即停止之前的定时器
  stopEntityExtractionScheduler()

  appLog(`[EntityExtraction] Scheduler started with interval ${intervalMs}ms`)

  // 立即执行一次
  processPendingJobs(5)

  // 设置定时器
  extractionTimer = setInterval(() => {
    processPendingJobs(5)
  }, intervalMs)

  // 返回停止函数
  return stopEntityExtractionScheduler
}

export function stopEntityExtractionScheduler(): void {
  if (extractionTimer) {
    clearInterval(extractionTimer)
    extractionTimer = null
    appLog("[EntityExtraction] Scheduler stopped")
  }
}

// 手动触发单篇文章的实体抽取
export async function extractEntitiesForEntry(entryId: string): Promise<void> {
  await processEntityExtraction(entryId)
}

// 获取实体的完整信息（包括时间线）
export async function getEntityWithTimeline(entityId: string) {
  const [entity, timeline] = await Promise.all([
    EntityService.getEntityById(entityId),
    EntityService.getTimelineByEntityId(entityId),
  ])

  if (!entity) {
    return null
  }

  return {
    ...entity,
    timeline,
  }
}
