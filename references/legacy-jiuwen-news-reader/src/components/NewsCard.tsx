import { useState } from 'react'
import { cn } from '@/utils/cn'
import type { NewsItem, ExtractedEntity } from '@/types'
import { EntityTagList } from './EntityTag'
import { extractEntitiesFromNews } from '@/services/aiService'
import { useUserStore } from '@/stores/userStore'
import { 
  Clock, 
  ExternalLink, 
  Sparkles, 
  Brain, 
  Zap, 
  ScanEye,
  Bookmark,
  CheckCircle2
} from 'lucide-react'

interface NewsCardProps {
  news: NewsItem
  onEntityClick?: (entity: ExtractedEntity) => void
  className?: string
}

// AI 分析动画组件
function AIAnalyzingOverlay() {
  return (
    <div className="absolute inset-0 bg-gradient-to-br from-slate-900/95 via-purple-950/95 to-blue-950/95 backdrop-blur-md rounded-xl flex flex-col items-center justify-center z-10 overflow-hidden">
      {/* 背景网格 */}
      <div className="absolute inset-0 opacity-20">
        <div className="absolute inset-0" style={{
          backgroundImage: `
            linear-gradient(rgba(6,182,212,0.3) 1px, transparent 1px),
            linear-gradient(90deg, rgba(6,182,212,0.3) 1px, transparent 1px)
          `,
          backgroundSize: '30px 30px'
        }} />
      </div>
      
      {/* 脉冲光环 */}
      <div className="relative">
        {/* 外圈光环 */}
        <div className="absolute inset-0 bg-cyan-500/20 rounded-full animate-ping" style={{ width: '120px', height: '120px', left: '-20px', top: '-20px' }} />
        <div className="absolute inset-0 bg-blue-500/30 rounded-full animate-ping animation-delay-200" style={{ width: '100px', height: '100px', left: '-10px', top: '-10px' }} />
        <div className="absolute inset-0 bg-purple-500/40 rounded-full animate-ping animation-delay-400" style={{ width: '80px', height: '80px' }} />
        
        {/* 旋转光环 */}
        <div className="absolute inset-0 w-24 h-24 -m-2">
          <div className="w-full h-full rounded-full border-2 border-cyan-400/50 border-t-transparent animate-spin" style={{ animationDuration: '1s' }} />
        </div>
        <div className="absolute inset-0 w-28 h-28 -m-4">
          <div className="w-full h-full rounded-full border-2 border-blue-400/30 border-b-transparent animate-spin" style={{ animationDuration: '1.5s', animationDirection: 'reverse' }} />
        </div>
        
        {/* 中心大脑图标 */}
        <div className="relative w-16 h-16 bg-gradient-to-br from-cyan-400 via-blue-500 to-purple-600 rounded-full flex items-center justify-center shadow-lg shadow-cyan-500/50">
          <Brain className="w-8 h-8 text-white animate-pulse" />
        </div>
      </div>
      
      {/* 文字 */}
      <div className="mt-8 text-center z-10">
        <p className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-300 to-purple-300 font-bold text-xl animate-pulse">
          AI 透视解析中
        </p>
        <p className="text-cyan-200/70 text-sm mt-2">正在提取关键实体...</p>
      </div>
      
      {/* 进度条 */}
      <div className="mt-4 w-48 h-1 bg-gray-700/50 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500 animate-shimmer" style={{ width: '60%' }} />
      </div>
      
      {/* 扫描线效果 */}
      <div className="absolute inset-0 overflow-hidden rounded-xl pointer-events-none">
        <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-lg shadow-cyan-400/50 animate-scan" />
      </div>
      
      {/* 粒子效果 */}
      <div className="absolute inset-0 pointer-events-none">
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="absolute w-1.5 h-1.5 bg-gradient-to-br from-cyan-400 to-blue-500 rounded-full animate-float shadow-lg shadow-cyan-400/50"
            style={{
              left: `${15 + i * 10}%`,
              top: `${20 + (i % 4) * 15}%`,
              animationDelay: `${i * 0.15}s`,
              animationDuration: `${2 + i * 0.3}s`,
            }}
          />
        ))}
      </div>
      
      {/* 角落装饰 */}
      <div className="absolute top-4 left-4 w-8 h-8 border-l-2 border-t-2 border-cyan-400/50 rounded-tl-lg" />
      <div className="absolute top-4 right-4 w-8 h-8 border-r-2 border-t-2 border-cyan-400/50 rounded-tr-lg" />
      <div className="absolute bottom-4 left-4 w-8 h-8 border-l-2 border-b-2 border-cyan-400/50 rounded-bl-lg" />
      <div className="absolute bottom-4 right-4 w-8 h-8 border-r-2 border-b-2 border-cyan-400/50 rounded-br-lg" />
    </div>
  )
}

export function NewsCard({ news, onEntityClick, className }: NewsCardProps) {
  const [entities, setEntities] = useState<ExtractedEntity[]>(news.entities || [])
  const [isExtracting, setIsExtracting] = useState(false)
  
  // 使用 userStore 获取阅读状态和收藏功能
  const { 
    isRead, 
    markAsRead, 
    isFavorite, 
    addToFavorites, 
    removeFromFavorites 
  } = useUserStore()
  
  const read = isRead(news.id)
  const favorited = isFavorite(news.id)
  
  // 格式化日期
  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      return date.toLocaleString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }
  
  // 手动触发实体抽取
  const handleExtractEntities = async () => {
    if (isExtracting || entities.length > 0) return
    
    setIsExtracting(true)
    try {
      const extracted = await extractEntitiesFromNews(news.title, news.content)
      setEntities(extracted)
    } catch (error) {
      console.error('实体抽取失败:', error)
    } finally {
      setIsExtracting(false)
    }
  }
  
  // 标记为已读
  const handleMarkAsRead = () => {
    if (!read) {
      markAsRead(news.id, news.title, news.sourceName)
    }
  }
  
  // 切换收藏状态
  const handleToggleFavorite = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (favorited) {
      removeFromFavorites(news.id)
    } else {
      addToFavorites(news.id, news.title, news.sourceName, news.link)
    }
  }
  
  return (
    <article
      className={cn(
        'relative bg-white rounded-xl shadow-sm border overflow-hidden',
        read ? 'border-gray-200 bg-gray-50/50' : 'border-gray-100',
        'hover:shadow-md transition-shadow duration-200',
        className
      )}
    >
      {/* AI 分析动画覆盖层 */}
      {isExtracting && <AIAnalyzingOverlay />}
      
      {/* 图片 */}
      {news.imageUrl && (
        <div className="aspect-video overflow-hidden bg-gray-100">
          <img
            src={news.imageUrl}
            alt={news.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}
      
      <div className="p-4 space-y-3">
        {/* 来源和时间 */}
        <div className="flex items-center gap-2 text-xs">
          <span className={cn(
            "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md",
            read ? "bg-gray-200 text-gray-500" : "bg-gray-100 text-gray-700"
          )}>
            <span className="text-sm">{news.icon || '📰'}</span>
            <span className="font-medium">{news.sourceName}</span>
          </span>
          {news.category && (
            <span className={cn(
              "px-1.5 py-0.5 rounded",
              read ? "bg-gray-100 text-gray-400" : "bg-gray-50 text-gray-400"
            )}>
              {news.category}
            </span>
          )}
          {/* 已读标记 */}
          {read && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-600 rounded text-xs">
              <CheckCircle2 className="w-3 h-3" />
              已读
            </span>
          )}
          <span className={cn(
            "flex items-center gap-1 ml-auto",
            read ? "text-gray-400" : "text-gray-500"
          )}>
            <Clock className="w-3 h-3" />
            {formatDate(news.pubDate)}
          </span>
        </div>
        
        {/* 标题 */}
        <h2 className={cn(
          "text-lg font-bold leading-snug",
          read ? "text-gray-500" : "text-gray-900"
        )}>
          <a
            href={news.link}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-red-600 transition-colors"
            onClick={handleMarkAsRead}
          >
            {news.title}
          </a>
        </h2>
        
        {/* 摘要 */}
        <p className={cn(
          "text-sm leading-relaxed line-clamp-3",
          read ? "text-gray-400" : "text-gray-600"
        )}>
          {news.summary}
        </p>
        
        {/* 操作按钮 */}
        <div className="flex items-center justify-between pt-2">
          {/* 左侧：实体标签或 AI 解析按钮 */}
          <div className="flex-1">
            {entities.length > 0 ? (
              <div className="pt-2">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="w-4 h-4 text-yellow-500" />
                  <span className="text-xs text-gray-500">智能识别实体</span>
                </div>
                <EntityTagList
                  entities={entities}
                  onEntityClick={onEntityClick}
                  size="sm"
                />
              </div>
            ) : (
              <button
                onClick={handleExtractEntities}
                disabled={isExtracting}
                className={cn(
                  'group flex items-center gap-2 px-4 py-2 rounded-full',
                  'bg-gradient-to-r from-purple-500 to-blue-500 text-white',
                  'hover:from-purple-600 hover:to-blue-600',
                  'transition-all duration-300 shadow-md hover:shadow-lg',
                  'disabled:opacity-70 disabled:cursor-not-allowed'
                )}
              >
                <ScanEye className="w-4 h-4 group-hover:animate-pulse" />
                <span className="font-medium">AI 透视解析</span>
                <Sparkles className="w-4 h-4 group-hover:animate-spin" />
              </button>
            )}
          </div>
          
          {/* 右侧：收藏按钮 */}
          <button
            onClick={handleToggleFavorite}
            className={cn(
              'p-2 rounded-lg transition-colors',
              favorited 
                ? 'text-yellow-500 bg-yellow-50 hover:bg-yellow-100' 
                : 'text-gray-400 hover:text-yellow-500 hover:bg-gray-100'
            )}
            title={favorited ? '取消收藏' : '收藏'}
          >
            <Bookmark className={cn('w-5 h-5', favorited && 'fill-current')} />
          </button>
        </div>
        
        {/* 阅读原文 */}
        <a
          href={news.link}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex items-center gap-1 text-sm font-medium",
            read ? "text-gray-400 hover:text-gray-500" : "text-red-600 hover:text-red-700"
          )}
          onClick={handleMarkAsRead}
        >
          阅读原文
          <ExternalLink className="w-4 h-4" />
        </a>
      </div>
    </article>
  )
}
