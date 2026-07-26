import { cn } from '@/utils/cn'
import type { TimelineEvent } from '@/types'
import { Calendar, ExternalLink } from 'lucide-react'

interface TimelineProps {
  events: TimelineEvent[]
  className?: string
}

export function Timeline({ events, className }: TimelineProps) {
  if (!events || events.length === 0) {
    return (
      <div className={cn('text-center py-8 text-gray-500', className)}>
        <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>暂无时间线数据</p>
        <p className="text-sm mt-1">时间线正在生成中，请稍后再来查看</p>
      </div>
    )
  }
  
  return (
    <div className={cn('space-y-0', className)}>
      {events.map((event, index) => (
        <TimelineItem
          key={event.id}
          event={event}
          isLast={index === events.length - 1}
        />
      ))}
    </div>
  )
}

interface TimelineItemProps {
  event: TimelineEvent
  isLast?: boolean
}

function TimelineItem({ event, isLast }: TimelineItemProps) {
  // 格式化日期
  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      if (isNaN(date.getTime())) {
        // 如果不是标准日期格式，直接返回
        return dateStr
      }
      return date.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    } catch {
      return dateStr
    }
  }
  
  return (
    <div className="relative pl-8 pb-8 last:pb-0">
      {/* 时间线轴线 */}
      {!isLast && (
        <div className="absolute left-[11px] top-6 bottom-0 w-0.5 bg-red-200" />
      )}
      
      {/* 时间点标记 */}
      <div className="absolute left-0 top-1.5 w-6 h-6 rounded-full bg-red-500 border-4 border-red-100 flex items-center justify-center">
        <div className="w-2 h-2 rounded-full bg-white" />
      </div>
      
      {/* 内容 */}
      <div className="space-y-2">
        {/* 日期 */}
        <div className="text-sm text-red-600 font-medium">
          {formatDate(event.date)}
        </div>
        
        {/* 标题 */}
        <h3 className="text-lg font-bold text-gray-900 leading-tight">
          {event.title}
        </h3>
        
        {/* 描述 */}
        <p className="text-gray-600 text-sm leading-relaxed">
          {event.description}
        </p>
        
        {/* 来源链接 */}
        {event.sourceUrl && (
          <a
            href={event.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 mt-2"
          >
            <span className="bg-gray-100 px-2 py-1 rounded">
              {event.sourceName || event.sourceTitle || '查看来源'}
            </span>
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  )
}
