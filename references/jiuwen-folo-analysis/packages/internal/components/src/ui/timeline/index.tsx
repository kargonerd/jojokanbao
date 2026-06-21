import { cn } from "@follow/utils/utils"
import type { TimelineEventModel } from "@follow/database/schemas"

interface TimelineItemProps {
  event: Pick<TimelineEventModel, "date" | "title" | "description" | "sourceUrl" | "sourceTitle" | "isVerified">
  isLast?: boolean
}

function TimelineItem({ event, isLast }: TimelineItemProps) {
  return (
    <div className="relative pl-8 pb-8 last:pb-0">
      {/* Timeline line */}
      {!isLast && (
        <div className="absolute left-[11px] top-6 bottom-0 w-0.5 bg-border" />
      )}

      {/* Timeline dot */}
      <div
        className={cn(
          "absolute left-0 top-1 w-6 h-6 rounded-full border-2 flex items-center justify-center",
          event.isVerified
            ? "bg-green-500 border-green-500 text-white"
            : "bg-background border-muted-foreground/30"
        )}
      >
        {event.isVerified && (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="space-y-2">
        <time className="text-sm font-medium text-muted-foreground">{event.date}</time>
        <h3 className="text-base font-semibold">{event.title}</h3>
        {event.description && (
          <p className="text-sm text-muted-foreground leading-relaxed">{event.description}</p>
        )}
        {event.sourceUrl && (
          <a
            href={event.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
          >
            <span>来源: {event.sourceTitle || "查看原文"}</span>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </a>
        )}
      </div>
    </div>
  )
}

interface TimelineProps {
  entityName: string
  events: Array<Pick<TimelineEventModel, "date" | "title" | "description" | "sourceUrl" | "sourceTitle" | "isVerified">>
  className?: string
}

export function Timeline({ entityName, events, className }: TimelineProps) {
  if (!events || events.length === 0) {
    return (
      <div className={cn("p-8 text-center", className)}>
        <div className="text-muted-foreground">暂无时间线数据</div>
      </div>
    )
  }

  return (
    <div className={cn("space-y-6", className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">{entityName} - 历史时间线</h2>
        <span className="text-sm text-muted-foreground">共 {events.length} 个事件</span>
      </div>

      <div className="relative">
        {events.map((event, index) => (
          <TimelineItem
            key={index}
            event={event}
            isLast={index === events.length - 1}
          />
        ))}
      </div>
    </div>
  )
}

interface TimelineSkeletonProps {
  className?: string
}

export function TimelineSkeleton({ className }: TimelineSkeletonProps) {
  return (
    <div className={cn("space-y-6 animate-pulse", className)}>
      <div className="h-7 w-48 bg-muted rounded" />
      <div className="space-y-8">
        {[1, 2, 3].map((i) => (
          <div key={i} className="relative pl-8">
            <div className="absolute left-0 top-1 w-6 h-6 rounded-full bg-muted" />
            <div className="space-y-2">
              <div className="h-4 w-24 bg-muted rounded" />
              <div className="h-5 w-3/4 bg-muted rounded" />
              <div className="h-4 w-full bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
