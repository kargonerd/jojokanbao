import { EntityTag, EntityTagList as EntityTagListUI } from "@follow/components/ui/entity-tag/index.js"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { useEntityModal } from "~/modules/entity-extraction/components/EntityDetailModal"
import { entities } from "~/queries/entities"

interface EntityTagListProps {
  entryId: string
}

export function EntityTagList({ entryId }: EntityTagListProps) {
  const { data: entitiesData, isLoading } = useQuery({
    ...entities.byEntry(entryId),
    enabled: !!entryId,
  })

  const { openEntityModal } = useEntityModal()

  const entityItems = useMemo(() => {
    if (!entitiesData) return []
    return entitiesData.map((item) => ({
      id: item.entity.id,
      name: item.entity.name,
      type: item.entity.type,
      description: item.entity.description || undefined,
      confidence: item.confidence,
      context: item.context,
    }))
  }, [entitiesData])

  if (isLoading) {
    return (
      <div className="flex flex-wrap gap-2 py-2">
        <div className="h-6 w-16 animate-pulse rounded-full bg-muted" />
        <div className="h-6 w-20 animate-pulse rounded-full bg-muted" />
        <div className="h-6 w-14 animate-pulse rounded-full bg-muted" />
      </div>
    )
  }

  if (entityItems.length === 0) {
    return null
  }

  return (
    <div className="py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <i className="i-mgc-tag-cute-re" />
        <span>文章实体</span>
      </div>
      <EntityTagListUI
        entities={entityItems}
        onEntityClick={(entity) => openEntityModal(entity.id)}
      />
    </div>
  )
}

// 简化的单个实体标签展示
export function EntryEntityTag({
  entityId,
  onClick,
}: {
  entityId: string
  onClick?: () => void
}) {
  const { data: entity } = useQuery({
    ...entities.byId(entityId),
    enabled: !!entityId,
  })

  if (!entity) return null

  return (
    <EntityTag
      entity={{
        id: entity.id,
        name: entity.name,
        type: entity.type,
        description: entity.description || undefined,
      }}
      onClick={onClick}
    />
  )
}
