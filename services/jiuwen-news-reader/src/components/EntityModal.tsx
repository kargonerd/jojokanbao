import { useState, useEffect, useCallback } from 'react'
import { X, User, Building2, FileText, Calendar, Lightbulb, Tag, MapPin, ExternalLink, Clock, TrendingUp } from 'lucide-react'
import { generateTimeline } from '@/services/aiService'
import type { ExtractedEntity, TimelineEvent } from '@/types'

interface EntityModalProps {
  entity: ExtractedEntity | null
  isOpen: boolean
  onClose: () => void
}

const entityTypeConfig = {
  person: {
    label: '人物',
    icon: User,
    color: 'bg-blue-100 text-blue-700',
    borderColor: 'border-blue-500',
    dotColor: 'bg-blue-500',
  },
  organization: {
    label: '机构',
    icon: Building2,
    color: 'bg-green-100 text-green-700',
    borderColor: 'border-green-500',
    dotColor: 'bg-green-500',
  },
  location: {
    label: '地点',
    icon: MapPin,
    color: 'bg-red-100 text-red-700',
    borderColor: 'border-red-500',
    dotColor: 'bg-red-500',
  },
  policy: {
    label: '政策',
    icon: FileText,
    color: 'bg-purple-100 text-purple-700',
    borderColor: 'border-purple-500',
    dotColor: 'bg-purple-500',
  },
  event: {
    label: '事件',
    icon: Calendar,
    color: 'bg-orange-100 text-orange-700',
    borderColor: 'border-orange-500',
    dotColor: 'bg-orange-500',
  },
  concept: {
    label: '概念',
    icon: Lightbulb,
    color: 'bg-teal-100 text-teal-700',
    borderColor: 'border-teal-500',
    dotColor: 'bg-teal-500',
  },
  other: {
    label: '其他',
    icon: Tag,
    color: 'bg-gray-100 text-gray-700',
    borderColor: 'border-gray-500',
    dotColor: 'bg-gray-500',
  },
}

function TimelineSkeleton() {
  return (
    <div className="space-y-6">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex gap-4 animate-pulse">
          <div className="w-20 flex-shrink-0">
            <div className="h-4 bg-gray-200 rounded w-12" />
            <div className="h-3 bg-gray-100 rounded w-16 mt-1" />
          </div>
          <div className="flex-1">
            <div className="h-5 bg-gray-200 rounded w-3/4" />
            <div className="h-3 bg-gray-100 rounded w-full mt-2" />
            <div className="h-3 bg-gray-100 rounded w-2/3 mt-1" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function EntityModal({ entity, isOpen, onClose }: EntityModalProps) {
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false)
  const [isExpanded, setIsExpanded] = useState<Record<string, boolean>>({})

  const loadTimeline = useCallback(async () => {
    if (!entity) return

    setIsLoadingTimeline(true)
    setTimeline([])
    setIsExpanded({})

    try {
      const events = await generateTimeline(entity.name, entity.type)
      setTimeline(events)
    } catch (error) {
      console.error('加载时间线失败:', error)
    } finally {
      setIsLoadingTimeline(false)
    }
  }, [entity])

  useEffect(() => {
    if (entity && isOpen) {
      loadTimeline()
    }
  }, [entity, isOpen, loadTimeline])

  const toggleExpand = (eventId: string) => {
    setIsExpanded(prev => ({ ...prev, [eventId]: !prev[eventId] }))
  }

  if (!isOpen || !entity) return null

  const config = entityTypeConfig[entity.type] || entityTypeConfig.other
  const EntityIcon = config.icon

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const month = date.getMonth() + 1
    const day = date.getDate()
    return `${month}月${day}日`
  }

  const formatDateShort = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toISOString().split('T')[0]
  }

  const groupEventsByYear = () => {
    const groups: Record<string, TimelineEvent[]> = {}
    timeline.forEach(event => {
      const year = event.date.split('-')[0]
      if (!groups[year]) groups[year] = []
      groups[year].push(event)
    })
    return Object.entries(groups).sort(([a], [b]) => Number(b) - Number(a))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-2xl max-h-[90vh] bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* 头部 */}
        <div className={`flex-shrink-0 px-6 py-5 border-l-4 ${config.borderColor} bg-gradient-to-r from-gray-50 to-white`}>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-xl ${config.color} flex items-center justify-center`}>
                <EntityIcon className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">{entity.name}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${config.color}`}>
                    {config.label}
                  </span>
                  {entity.confidence && (
                    <span className="text-xs text-gray-400">置信度 {entity.confidence}%</span>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 rounded-xl transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </div>

        {/* 简介 */}
        {entity.description && (
          <div className="flex-shrink-0 px-6 py-4 border-b border-gray-100 bg-amber-50/50">
            <div className="flex items-start gap-2">
              <TrendingUp className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-medium text-amber-700 mb-1">深度解读</p>
                <p className="text-sm text-gray-700 leading-relaxed">{entity.description}</p>
              </div>
            </div>
          </div>
        )}

        {/* 原文引用 */}
        {entity.context && (
          <div className="flex-shrink-0 px-6 py-4 border-b border-gray-100 bg-gray-50/50">
            <p className="text-xs font-medium text-gray-500 mb-2">原文引用</p>
            <blockquote className="text-sm text-gray-600 italic border-l-2 border-gray-300 pl-3">
              "{entity.context}"
            </blockquote>
          </div>
        )}

        {/* 时间线 */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="flex items-center gap-2 mb-5">
            <Clock className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">相关事件时间线</h3>
          </div>

          {isLoadingTimeline ? (
            <div className="ml-4">
              <TimelineSkeleton />
            </div>
          ) : timeline.length > 0 ? (
            <div className="relative">
              {/* 时间线竖线 */}
              <div className="absolute left-[5.75rem] top-0 bottom-0 w-0.5 bg-gray-200" />

              {groupEventsByYear().map(([year, yearEvents]) => (
                <div key={year} className="mb-6">
                  <div className="relative ml-4 mb-4">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-100 rounded-full text-xs font-bold text-gray-600">
                      {year}年
                    </span>
                  </div>
                  {yearEvents.map((event) => (
                    <div key={event.id} className="relative mb-4 ml-4">
                      {/* 时间点 */}
                      <div className="absolute left-0 top-1.5 z-10">
                        <div className={`w-3 h-3 rounded-full ${config.dotColor} ring-4 ring-white`} />
                      </div>

                      {/* 内容卡片 */}
                      <div className="ml-8">
                        <div className="flex items-baseline gap-3 mb-1">
                          <span className="text-sm font-bold text-gray-800">{formatDate(event.date)}</span>
                          <span className="text-xs text-gray-400">{formatDateShort(event.date)}</span>
                        </div>

                        <div className="bg-gray-50 rounded-xl p-4 hover:bg-gray-100 transition-colors cursor-pointer" onClick={() => toggleExpand(event.id)}>
                          <h4 className="text-sm font-semibold text-gray-900 leading-snug mb-2">{event.title}</h4>
                          
                          <p className={`text-sm text-gray-600 leading-relaxed ${
                            isExpanded[event.id] ? '' : 'line-clamp-2'
                          }`}>
                            {event.description}
                          </p>

                          {/* 来源标签 */}
                          <div className="flex flex-wrap gap-1.5 mt-3">
                            {event.sourceTitle && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-gray-200 rounded-md text-xs text-gray-500">
                                {event.sourceTitle}
                              </span>
                            )}
                            {event.sourceUrl && (
                              <a
                                href={event.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-gray-200 rounded-md text-xs text-blue-500 hover:text-blue-600 hover:border-blue-300 transition-colors"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExternalLink className="w-3 h-3" />
                                查看原文
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <Clock className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm">暂无时间线数据</p>
              <p className="text-xs mt-1">时间线正在生成中，请稍后再来查看</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
