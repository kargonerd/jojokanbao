import { Button } from "@follow/components/ui/button/index.js"
import { Timeline } from "@follow/components/ui/timeline/index.js"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { useModalStack } from "~/components/ui/modal/stacked/hooks"
import { entities } from "~/queries/entities"

interface EntityDetailModalProps {
  entityId: string
}

export function EntityDetailModal({ entityId }: EntityDetailModalProps) {
  const { data: entity, isLoading: isLoadingEntity } = useQuery({
    ...entities.byId(entityId),
    enabled: !!entityId,
  })

  const { data: timelineEvents, isLoading: isLoadingTimeline } = useQuery({
    ...entities.timeline(entityId),
    enabled: !!entityId,
  })

  const timelineData = useMemo(() => {
    if (!timelineEvents) return []
    return timelineEvents.map((event) => ({
      date: event.date,
      title: event.title,
      description: event.description || "",
      sourceUrl: event.sourceUrl || "",
      sourceTitle: event.sourceTitle || "",
    }))
  }, [timelineEvents])

  const entityTypeLabels: Record<string, string> = {
    person: "人物",
    organization: "机构",
    policy: "政策",
    event: "事件",
    concept: "概念",
    other: "其他",
  }

  const { dismiss } = useModalStack()

  return (
    <div className="flex max-h-[80vh] max-w-2xl flex-col">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-start justify-between">
          <div>
            {isLoadingEntity ? (
              <div className="h-8 w-32 animate-pulse rounded bg-muted" />
            ) : entity ? (
              <>
                <h2 className="text-2xl font-bold">{entity.name}</h2>
                <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {entityTypeLabels[entity.type] || entity.type}
                  </span>
                  <span>•</span>
                  <span>提及 {entity.mentionCount} 次</span>
                </div>
              </>
            ) : (
              <h2 className="text-2xl font-bold">实体详情</h2>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={() => dismiss()}>
            <i className="i-mgc-close-cute-re" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="overflow-y-auto p-6">
        {isLoadingEntity ? (
          <div className="space-y-4">
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          </div>
        ) : entity ? (
          <>
            {/* 实体描述 */}
            {entity.description && (
              <div className="mb-6">
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">简介</h3>
                <p className="text-sm leading-relaxed">{entity.description}</p>
              </div>
            )}

            {/* 时间线 */}
            <div>
              <h3 className="mb-4 text-sm font-medium text-muted-foreground">相关事件</h3>
              {isLoadingTimeline ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex gap-4">
                      <div className="h-12 w-24 animate-pulse rounded bg-muted" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
                        <div className="h-3 w-full animate-pulse rounded bg-muted" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : timelineData.length > 0 ? (
                <Timeline entityName={entity.name} events={timelineData} />
              ) : (
                <div className="rounded-lg border border-dashed p-8 text-center">
                  <i className="i-mgc-time-cute-re mx-auto mb-2 text-2xl text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">暂无相关事件数据</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    时间线正在生成中，请稍后再来查看
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="py-8 text-center text-muted-foreground">
            <i className="i-mgc-warning-cute-re mx-auto mb-2 text-3xl" />
            <p>未找到实体信息</p>
          </div>
        )}
      </div>
    </div>
  )
}

// 使用 modal stack 打开实体详情
export function useEntityModal() {
  const { present } = useModalStack()

  const openEntityModal = (entityId: string) => {
    present({
      title: "",
      content: () => <EntityDetailModal entityId={entityId} />,
      canClose: true,
      clickOutsideToDismiss: true,
    })
  }

  return { openEntityModal }
}
