import { cn } from "@follow/utils/utils"
import type { EntityModel } from "@follow/database/schemas"

interface EntityTagProps {
  entity: Pick<EntityModel, "name" | "type" | "mentionCount">
  onClick?: () => void
  className?: string
}

const entityTypeConfig = {
  person: {
    label: "人物",
    color: "bg-blue-100 text-blue-700 border-blue-200",
    icon: "👤",
  },
  organization: {
    label: "机构",
    color: "bg-green-100 text-green-700 border-green-200",
    icon: "🏢",
  },
  policy: {
    label: "政策",
    color: "bg-purple-100 text-purple-700 border-purple-200",
    icon: "📜",
  },
  event: {
    label: "事件",
    color: "bg-orange-100 text-orange-700 border-orange-200",
    icon: "📅",
  },
  concept: {
    label: "概念",
    color: "bg-pink-100 text-pink-700 border-pink-200",
    icon: "💡",
  },
  other: {
    label: "其他",
    color: "bg-gray-100 text-gray-700 border-gray-200",
    icon: "📌",
  },
}

export function EntityTag({ entity, onClick, className }: EntityTagProps) {
  const config = entityTypeConfig[entity.type] || entityTypeConfig.other

  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
        "border transition-all duration-200",
        "hover:shadow-sm hover:scale-105 active:scale-95",
        config.color,
        className
      )}
    >
      <span>{config.icon}</span>
      <span>{entity.name}</span>
      {entity.mentionCount && entity.mentionCount > 1 && (
        <span className="ml-0.5 opacity-60">({entity.mentionCount})</span>
      )}
    </button>
  )
}

interface EntityTagListProps {
  entities: Array<Pick<EntityModel, "name" | "type" | "mentionCount">>
  onEntityClick?: (entity: Pick<EntityModel, "name" | "type" | "mentionCount">) => void
  className?: string
}

export function EntityTagList({ entities, onEntityClick, className }: EntityTagListProps) {
  if (!entities || entities.length === 0) {
    return null
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {entities.map((entity, index) => (
        <EntityTag
          key={`${entity.name}-${index}`}
          entity={entity}
          onClick={() => onEntityClick?.(entity)}
        />
      ))}
    </div>
  )
}
