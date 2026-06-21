import { EntityService } from "@follow/database/services/entity"
import { defineQuery } from "~/lib/defineQuery"

export const entities = {
  // 获取文章中的实体
  byEntry: (entryId: string) =>
    defineQuery(
      ["entities", "entry", entryId],
      async () => {
        const entities = await EntityService.getEntitiesByEntryId(entryId)
        return entities
      },
      {
        rootKey: ["entities", "entry"],
      },
    ),

  // 获取实体详情
  byId: (entityId: string) =>
    defineQuery(
      ["entities", "detail", entityId],
      async () => {
        const entity = await EntityService.getEntityById(entityId)
        return entity
      },
      {
        rootKey: ["entities", "detail"],
      },
    ),

  // 获取实体的时间线
  timeline: (entityId: string) =>
    defineQuery(
      ["entities", "timeline", entityId],
      async () => {
        const events = await EntityService.getTimelineByEntityId(entityId)
        return events
      },
      {
        rootKey: ["entities", "timeline"],
      },
    ),

  // 获取热门实体
  popular: (type?: string, limit: number = 20) =>
    defineQuery(
      ["entities", "popular", type || "all", limit],
      async () => {
        const entities = await EntityService.getPopularEntities(type, limit)
        return entities
      },
      {
        rootKey: ["entities", "popular"],
      },
    ),

  // 搜索实体
  search: (query: string, limit: number = 10) =>
    defineQuery(
      ["entities", "search", query, limit],
      async () => {
        if (!query.trim()) return []
        const entities = await EntityService.searchEntities(query, limit)
        return entities
      },
      {
        rootKey: ["entities", "search"],
      },
    ),

  // 获取文章的抽取状态
  extractionStatus: (entryId: string) =>
    defineQuery(
      ["entities", "extraction", entryId],
      async () => {
        const job = await EntityService.getJobByEntryId(entryId)
        return job
      },
      {
        rootKey: ["entities", "extraction"],
      },
    ),
}
