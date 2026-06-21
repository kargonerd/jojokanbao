import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { db } from "../db"
import {
  entitiesTable,
  entryEntitiesTable,
  timelineEventsTable,
  entityExtractionJobsTable,
} from "../schemas"
import type {
  EntityModel,
  EntryEntityModel,
  TimelineEventModel,
  EntityExtractionJobModel,
} from "../schemas"
import type { Resetable } from "./internal/base"

// 抽取的实体数据类型
export interface ExtractedEntityData {
  name: string
  type: "person" | "organization" | "policy" | "event" | "concept" | "other"
  description?: string
  confidence: number
  context: string
}

// 时间线事件数据类型
export interface TimelineEventData {
  date: string
  title: string
  description: string
  sourceUrl?: string
  sourceTitle?: string
  sourceEntryId?: string
}

class EntityServiceStatic implements Resetable {
  // ========== 实体 CRUD ==========

  async reset() {
    await db.delete(entitiesTable).execute()
    await db.delete(entryEntitiesTable).execute()
    await db.delete(timelineEventsTable).execute()
    await db.delete(entityExtractionJobsTable).execute()
  }

  // 创建或更新实体
  async upsertEntity(
    entity: Partial<EntityModel> & { name: string; type: EntityModel["type"] }
  ): Promise<string> {
    const now = new Date()
    const id = entity.id || `${entity.type}_${entity.name}_${now.getTime()}`

    await db
      .insert(entitiesTable)
      .values({
        id,
        name: entity.name,
        type: entity.type,
        description: entity.description || null,
        firstMentionedAt: entity.firstMentionedAt || now,
        lastMentionedAt: entity.lastMentionedAt || now,
        mentionCount: entity.mentionCount || 1,
        timelineData: entity.timelineData || null,
        timelineUpdatedAt: entity.timelineUpdatedAt || null,
        createdAt: entity.createdAt || now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [entitiesTable.name, entitiesTable.type],
        set: {
          description: entity.description || null,
          lastMentionedAt: now,
          mentionCount: sql`${entitiesTable.mentionCount} + 1`,
          updatedAt: now,
        },
      })

    return id
  }

  // 获取实体 by ID
  async getEntityById(id: string): Promise<EntityModel | null> {
    const result = await db.query.entitiesTable.findFirst({
      where: eq(entitiesTable.id, id),
    })
    return result || null
  }

  // 获取实体 by name and type
  async getEntityByNameAndType(
    name: string,
    type: string
  ): Promise<EntityModel | null> {
    const result = await db.query.entitiesTable.findFirst({
      where: and(eq(entitiesTable.name, name), eq(entitiesTable.type, type as EntityModel["type"])),
    })
    return result || null
  }

  // 获取热门实体
  async getPopularEntities(
    type?: string,
    limit: number = 20
  ): Promise<EntityModel[]> {
    return db.query.entitiesTable.findMany({
      where: type ? eq(entitiesTable.type, type as EntityModel["type"]) : undefined,
      orderBy: desc(entitiesTable.mentionCount),
      limit,
    })
  }

  // 搜索实体
  async searchEntities(query: string, limit: number = 10): Promise<EntityModel[]> {
    return db.query.entitiesTable.findMany({
      where: sql`${entitiesTable.name} LIKE ${`%${query}%`}`,
      limit,
    })
  }

  // ========== 文章-实体关联 ==========

  // 为文章添加实体关联
  async addEntityToEntry(
    entryId: string,
    entityId: string,
    confidence: number,
    context: string
  ): Promise<void> {
    const id = `${entryId}_${entityId}`
    await db
      .insert(entryEntitiesTable)
      .values({
        id,
        entryId,
        entityId,
        confidence,
        context: context || null,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
  }

  // 获取文章的实体列表
  async getEntitiesByEntryId(entryId: string): Promise<
    Array<{
      entity: EntityModel
      confidence: number
      context: string | null
    }>
  > {
    const results = await db.query.entryEntitiesTable.findMany({
      where: eq(entryEntitiesTable.entryId, entryId),
      with: {
        entity: true,
      },
      orderBy: desc(entryEntitiesTable.confidence),
    })

    return results.map((r: any) => ({
      entity: r.entity as EntityModel,
      confidence: r.confidence,
      context: r.context,
    }))
  }

  // 获取提及实体的文章列表
  async getEntriesByEntityId(entityId: string, limit: number = 20): Promise<string[]> {
    const results = await db.query.entryEntitiesTable.findMany({
      where: eq(entryEntitiesTable.entityId, entityId),
      orderBy: desc(entryEntitiesTable.createdAt),
      limit,
    })
    return results.map((r) => r.entryId)
  }

  // ========== 时间线事件 ==========

  // 添加时间线事件
  async addTimelineEvent(
    entityId: string,
    event: TimelineEventData
  ): Promise<string> {
    const id = `${entityId}_${event.date}_${Date.now()}`
    await db.insert(timelineEventsTable).values({
      id,
      entityId,
      date: event.date,
      title: event.title,
      description: event.description || null,
      sourceUrl: event.sourceUrl || null,
      sourceTitle: event.sourceTitle || null,
      sourceEntryId: event.sourceEntryId || null,
      createdAt: new Date(),
    })
    return id
  }

  // 批量添加时间线事件
  async addTimelineEvents(
    entityId: string,
    events: TimelineEventData[]
  ): Promise<void> {
    if (events.length === 0) return
    const now = new Date()
    await db.insert(timelineEventsTable).values(
      events.map((event, index) => ({
        id: `${entityId}_${event.date}_${now.getTime()}_${index}`,
        entityId,
        date: event.date,
        title: event.title,
        description: event.description || null,
        sourceUrl: event.sourceUrl || null,
        sourceTitle: event.sourceTitle || null,
        sourceEntryId: event.sourceEntryId || null,
        createdAt: now,
      }))
    )
  }

  // 获取实体的时间线
  async getTimelineByEntityId(
    entityId: string
  ): Promise<TimelineEventModel[]> {
    return db.query.timelineEventsTable.findMany({
      where: eq(timelineEventsTable.entityId, entityId),
      orderBy: timelineEventsTable.date,
    })
  }

  // 更新时间线缓存
  async updateEntityTimelineCache(
    entityId: string,
    events: Array<{
      date: string
      title: string
      description: string
      sourceUrl: string
      sourceTitle: string
    }>
  ): Promise<void> {
    await db
      .update(entitiesTable)
      .set({
        timelineData: {
          events,
          generatedAt: new Date().toISOString(),
        },
        timelineUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(entitiesTable.id, entityId))
  }

  // ========== 实体抽取任务 ==========

  // 创建抽取任务
  async createExtractionJob(entryId: string): Promise<string> {
    const id = `job_${entryId}_${Date.now()}`
    await db
      .insert(entityExtractionJobsTable)
      .values({
        id,
        entryId,
        status: "pending",
        errorMessage: null,
        extractedEntities: null,
        createdAt: new Date(),
        completedAt: null,
      })
      .onConflictDoNothing()
    return id
  }

  // 获取待处理的任务
  async getPendingJobs(limit: number = 10): Promise<EntityExtractionJobModel[]> {
    return db.query.entityExtractionJobsTable.findMany({
      where: eq(entityExtractionJobsTable.status, "pending"),
      orderBy: entityExtractionJobsTable.createdAt,
      limit,
    })
  }

  // 更新任务状态
  async updateJobStatus(
    jobId: string,
    status: "pending" | "processing" | "completed" | "failed",
    data?: {
      errorMessage?: string
      extractedEntities?: ExtractedEntityData[]
    }
  ): Promise<void> {
    const update: Partial<EntityExtractionJobModel> = { status }
    if (status === "completed" || status === "failed") {
      update.completedAt = new Date()
    }
    if (data?.errorMessage) {
      update.errorMessage = data.errorMessage
    }
    if (data?.extractedEntities) {
      update.extractedEntities = data.extractedEntities
    }
    await db
      .update(entityExtractionJobsTable)
      .set(update)
      .where(eq(entityExtractionJobsTable.id, jobId))
  }

  // 获取文章的抽取任务
  async getJobByEntryId(
    entryId: string
  ): Promise<EntityExtractionJobModel | null> {
    const result = await db.query.entityExtractionJobsTable.findFirst({
      where: eq(entityExtractionJobsTable.entryId, entryId),
    })
    return result || null
  }

  // ========== 批量处理 ==========

  // 处理抽取结果并保存
  async processExtractionResult(
    entryId: string,
    entities: ExtractedEntityData[]
  ): Promise<void> {
    for (const entityData of entities) {
      // 1. 创建或更新实体
      const entityId = await this.upsertEntity({
        name: entityData.name,
        type: entityData.type,
        description: entityData.description,
        firstMentionedAt: new Date(),
        lastMentionedAt: new Date(),
        mentionCount: 1,
      })

      // 2. 创建文章-实体关联
      await this.addEntityToEntry(
        entryId,
        entityId,
        entityData.confidence,
        entityData.context
      )
    }
  }
}

export const EntityService = new EntityServiceStatic()
