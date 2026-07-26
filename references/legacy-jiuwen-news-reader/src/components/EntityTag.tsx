import { cn } from '@/utils/cn'
import type { ExtractedEntity } from '@/types'

interface EntityTagProps {
  entity: Pick<ExtractedEntity, 'name' | 'type'>
  onClick?: () => void
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

const entityTypeConfig: Record<string, { label: string; color: string; icon: string }> = {
  person: {
    label: '人物',
    color: 'bg-blue-100 text-blue-700 border-blue-200',
    icon: '👤',
  },
  organization: {
    label: '机构',
    color: 'bg-green-100 text-green-700 border-green-200',
    icon: '🏢',
  },
  location: {
    label: '地点',
    color: 'bg-red-100 text-red-700 border-red-200',
    icon: '📍',
  },
  policy: {
    label: '政策',
    color: 'bg-purple-100 text-purple-700 border-purple-200',
    icon: '📋',
  },
  event: {
    label: '事件',
    color: 'bg-orange-100 text-orange-700 border-orange-200',
    icon: '📅',
  },
  concept: {
    label: '概念',
    color: 'bg-teal-100 text-teal-700 border-teal-200',
    icon: '💡',
  },
  other: {
    label: '其他',
    color: 'bg-gray-100 text-gray-700 border-gray-200',
    icon: '🏷️',
  },
}

export function EntityTag({ entity, onClick, className, size = 'md' }: EntityTagProps) {
  const config = entityTypeConfig[entity.type] || entityTypeConfig.other
  
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
    lg: 'px-3 py-1.5 text-base',
  }
  
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium transition-all duration-200',
        'hover:shadow-md active:scale-95',
        config.color,
        sizeClasses[size],
        onClick && 'cursor-pointer hover:opacity-80',
        className
      )}
    >
      <span className="opacity-80">{config.icon}</span>
      <span>{entity.name}</span>
    </button>
  )
}

interface EntityTagListProps {
  entities: ExtractedEntity[]
  onEntityClick?: (entity: ExtractedEntity) => void
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

export function EntityTagList({ entities, onEntityClick, className, size = 'md' }: EntityTagListProps) {
  if (!entities || entities.length === 0) {
    return null
  }
  
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {entities.map((entity) => (
        <EntityTag
          key={entity.id}
          entity={entity}
          onClick={() => onEntityClick?.(entity)}
          size={size}
        />
      ))}
    </div>
  )
}
