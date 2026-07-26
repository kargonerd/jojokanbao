import { useCallback, useEffect, useState } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useRSSStore } from '@/stores/rssStore'
import { fetchMultipleSources, getDefaultSources } from '@/services/rssService'
import { NewsCard } from '@/components/NewsCard'
import { EntityModal } from '@/components/EntityModal'
import { SettingsModal } from '@/components/SettingsModal'
import type { ExtractedEntity } from '@/types'
import { 
  RefreshCw, 
  Newspaper,
  Loader2,
  Settings,
} from 'lucide-react'
import { cn } from '@/utils/cn'

export function HomePage() {
  const { user } = useUserStore()
  const { 
    availableSources,
    selectedSourceIds, 
    setAvailableSources,
    news, 
    setNews, 
    isLoading, 
    setLoading,
    error,
    setError,
    updateLastFetchTime,
  } = useRSSStore()
  
  const [selectedEntity, setSelectedEntity] = useState<ExtractedEntity | null>(null)
  const [isEntityModalOpen, setIsEntityModalOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [activeSettingsTab, setActiveSettingsTab] = useState<'profile' | 'sources' | 'account'>('profile')

  // 加载新闻源
  useEffect(() => {
    const loadSources = async () => {
      try {
        const sources = await getDefaultSources()
        setAvailableSources(sources)
      } catch (err) {
        console.error('加载新闻源失败:', err)
      }
    }
    loadSources()
  }, [setAvailableSources])
  
  // 加载新闻
  const loadNews = useCallback(async () => {
    if (selectedSourceIds.length === 0) return
    
    setLoading(true)
    setError(null)
    try {
      const items = await fetchMultipleSources(selectedSourceIds)
      setNews(items)
      updateLastFetchTime()
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [selectedSourceIds, setError, setLoading, setNews, updateLastFetchTime])
  
  // 初始加载
  useEffect(() => {
    if (availableSources.length > 0 && selectedSourceIds.length > 0) {
      loadNews()
    }
  }, [availableSources.length, selectedSourceIds.length, loadNews])
  
  // 处理实体点击
  const handleEntityClick = (entity: ExtractedEntity) => {
    setSelectedEntity(entity)
    setIsEntityModalOpen(true)
  }

  // 打开设置并切换到新闻源标签
  const openSourceSettings = () => {
    setActiveSettingsTab('sources')
    setIsSettingsOpen(true)
  }
  
  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-40 bg-white border-b border-gray-100 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-red-500 rounded-lg flex items-center justify-center">
              <Newspaper className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-gray-900 hidden sm:block">新闻合订本</span>
          </div>
          
          {/* 中间占位 */}
          <div className="flex-1" />
          
          {/* 用户 */}
          <div className="flex items-center gap-2">
            <button
              onClick={loadNews}
              disabled={isLoading}
              className="p-2 hover:bg-gray-100 rounded-lg disabled:opacity-50"
              title="刷新新闻"
            >
              <RefreshCw className={cn('w-5 h-5 text-gray-600', isLoading && 'animate-spin')} />
            </button>
            
            <button
              onClick={() => {
                setActiveSettingsTab('profile')
                setIsSettingsOpen(true)
              }}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              title="设置"
            >
              <Settings className="w-5 h-5 text-gray-600" />
            </button>
            
            <button
              onClick={() => {
                setActiveSettingsTab('profile')
                setIsSettingsOpen(true)
              }}
              className="flex items-center gap-2 pl-2 border-l border-gray-200 hover:bg-gray-100 rounded-lg p-2 transition-colors"
            >
              <span className="text-xl">{user?.avatar}</span>
              <span className="text-sm font-medium text-gray-700 hidden sm:block">
                {user?.nickname}
              </span>
            </button>
          </div>
        </div>
      </header>


      {/* 主内容 */}
      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* 错误提示 */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl text-center">
            <p className="text-red-600">{error}</p>
            <button
              onClick={loadNews}
              className="mt-2 text-sm text-red-600 hover:text-red-700 font-medium"
            >
              重试
            </button>
          </div>
        )}
        
        {/* 加载中 */}
        {isLoading && news.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="w-10 h-10 text-red-500 animate-spin" />
            <p className="mt-4 text-gray-500">正在加载新闻...</p>
          </div>
        )}
        
        {/* 新闻列表 */}
        <div className="space-y-4">
          {news.map((item) => (
            <NewsCard
              key={item.id}
              news={item}
              onEntityClick={handleEntityClick}
            />
          ))}
        </div>
        
        {/* 未选择新闻源提示 */}
        {!isLoading && selectedSourceIds.length === 0 && availableSources.length > 0 && (
          <div className="text-center py-20">
            <Newspaper className="w-16 h-16 mx-auto text-gray-300" />
            <p className="mt-4 text-gray-500">你还没有选择新闻源</p>
            <button
              onClick={openSourceSettings}
              className="mt-4 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
            >
              去选择新闻源
            </button>
          </div>
        )}
        
        {/* 空状态 */}
        {!isLoading && news.length === 0 && !error && selectedSourceIds.length > 0 && (
          <div className="text-center py-20">
            <Newspaper className="w-16 h-16 mx-auto text-gray-300" />
            <p className="mt-4 text-gray-500">暂无新闻</p>
            <button
              onClick={loadNews}
              className="mt-4 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
            >
              刷新
            </button>
          </div>
        )}
      </main>
      
      {/* 实体详情弹窗 */}
      <EntityModal
        entity={selectedEntity}
        isOpen={isEntityModalOpen}
        onClose={() => {
          setIsEntityModalOpen(false)
          setSelectedEntity(null)
        }}
      />
      
      {/* 设置弹窗 */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        activeTab={activeSettingsTab}
        onTabChange={setActiveSettingsTab}
      />
    </div>
  )
}
