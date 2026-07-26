import { useState, useEffect } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useRSSStore } from '@/stores/rssStore'
import { cn } from '@/utils/cn'
import { User, ArrowRight, Newspaper, Check, Globe, Cpu, DollarSign, Loader2 } from 'lucide-react'
import { getDefaultSources } from '@/services/rssService'
import type { RSSSource } from '@/types'

const AVATAR_OPTIONS = [
  '👤', '👨', '👩', '🧑', '👴', '👵', '👶', '🧒',
  '🐱', '🐶', '🐼', '🦊', '🦁', '🐯', '🐨', '🐮',
  '🤖', '👽', '👻', '🤡', '💩', '🎃', '🦄', '🐉',
]

const categoryIcons: Record<string, any> = {
  '中文': Globe,
  '国际': Globe,
  '科技': Cpu,
  '财经': DollarSign,
}

export function LoginPage() {
  const [nickname, setNickname] = useState('')
  const [selectedAvatar, setSelectedAvatar] = useState('👤')
  const [step, setStep] = useState(1)
  const [availableSources, setAvailableSources] = useState<RSSSource[]>([])
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [isLoadingSources, setIsLoadingSources] = useState(false)
  
  const login = useUserStore((state) => state.login)
  const setRSSSources = useRSSStore((state) => state.setSources)
  const setRSSAvailableSources = useRSSStore((state) => state.setAvailableSources)
  
  // 加载新闻源
  useEffect(() => {
    const loadSources = async () => {
      setIsLoadingSources(true)
      try {
        const sources = await getDefaultSources()
        setAvailableSources(sources)
        // 默认选择一些常用源
        const defaultSelected = sources
          .filter(s => ['zaobao', 'thepaper', '36kr', 'hackernews'].includes(s.id))
          .map(s => s.id)
        setSelectedSourceIds(defaultSelected)
      } catch (err) {
        console.error('加载新闻源失败:', err)
      } finally {
        setIsLoadingSources(false)
      }
    }
    loadSources()
  }, [])
  
  const handleLogin = () => {
    // 保存选择的新闻源
    setRSSAvailableSources(availableSources)
    setRSSSources(selectedSourceIds)
    login(nickname || undefined, selectedAvatar)
  }
  
  const toggleSource = (sourceId: string) => {
    setSelectedSourceIds(prev => 
      prev.includes(sourceId) 
        ? prev.filter(id => id !== sourceId)
        : [...prev, sourceId]
    )
  }
  
  // 按分类分组
  const groupedSources = availableSources.reduce<Record<string, RSSSource[]>>((acc, source) => {
    const cat = source.category || '其他'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(source)
    return acc
  }, {})
  
  const selectedCount = selectedSourceIds.length
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-red-500 rounded-2xl shadow-lg mb-4">
            <Newspaper className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">新闻合订本</h1>
          <p className="text-gray-600 mt-2">AI 驱动的智能新闻阅读器</p>
        </div>
        
        {/* 登录卡片 */}
        <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8">
          {step === 1 ? (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-gray-900">欢迎使用</h2>
                <p className="text-gray-500 mt-1">设置你的昵称和头像开始阅读</p>
              </div>
              
              {/* 头像选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  选择头像
                </label>
                <div className="grid grid-cols-6 gap-2">
                  {AVATAR_OPTIONS.map((avatar) => (
                    <button
                      key={avatar}
                      onClick={() => setSelectedAvatar(avatar)}
                      className={cn(
                        'aspect-square flex items-center justify-center text-2xl rounded-lg transition-all',
                        'hover:bg-gray-100',
                        selectedAvatar === avatar
                          ? 'bg-red-100 ring-2 ring-red-500'
                          : 'bg-gray-50'
                      )}
                    >
                      {avatar}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* 昵称输入 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  昵称（可选）
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder={`用户${Math.random().toString(36).substring(2, 8)}`}
                    className={cn(
                      'w-full pl-10 pr-4 py-3 rounded-lg border border-gray-200',
                      'focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent',
                      'placeholder:text-gray-400'
                    )}
                    maxLength={20}
                  />
                </div>
              </div>
              
              {/* 下一步按钮 */}
              <button
                onClick={() => setStep(2)}
                className={cn(
                  'w-full py-3 px-4 bg-red-500 text-white rounded-lg font-medium',
                  'hover:bg-red-600 active:bg-red-700 transition-colors',
                  'flex items-center justify-center gap-2'
                )}
              >
                下一步
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          ) : step === 2 ? (
            <div className="space-y-4">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-gray-900">选择新闻源</h2>
                <p className="text-gray-500 mt-1">选择你感兴趣的媒体，随时可以在设置中修改</p>
              </div>
              
              {isLoadingSources ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <Loader2 className="w-8 h-8 text-red-500 animate-spin" />
                  <p className="mt-2 text-sm text-gray-500">加载新闻源...</p>
                </div>
              ) : (
                <>
                  {/* 快捷操作 */}
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-600">
                      已选择 <span className="font-medium text-red-500">{selectedCount}</span> 个
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setSelectedSourceIds(availableSources.map(s => s.id))}
                        className="text-xs text-red-500 hover:text-red-600 font-medium"
                      >
                        全选
                      </button>
                      <span className="text-gray-300">|</span>
                      <button
                        onClick={() => setSelectedSourceIds([])}
                        className="text-xs text-gray-500 hover:text-gray-600 font-medium"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                  
                  {/* 新闻源列表 */}
                  <div className="space-y-3 max-h-64 overflow-y-auto border border-gray-100 rounded-xl p-3">
                    {Object.entries(groupedSources).map(([category, sources]) => {
                      const CategoryIcon = categoryIcons[category] || Globe
                      const allSelected = sources.every(s => selectedSourceIds.includes(s.id))
                      const someSelected = sources.some(s => selectedSourceIds.includes(s.id))
                      
                      return (
                        <div key={category}>
                          <div className="flex items-center gap-2 mb-2">
                            <CategoryIcon className="w-4 h-4 text-gray-400" />
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{category}</span>
                            <button
                              onClick={() => {
                                const categorySourceIds = sources.map(s => s.id)
                                if (allSelected) {
                                  setSelectedSourceIds(prev => prev.filter(id => !categorySourceIds.includes(id)))
                                } else {
                                  setSelectedSourceIds(prev => [...new Set([...prev, ...categorySourceIds])])
                                }
                              }}
                              className={cn(
                                'w-4 h-4 rounded border flex items-center justify-center transition-colors ml-auto',
                                allSelected ? 'bg-red-500 border-red-500' : someSelected ? 'border-red-500 bg-red-50' : 'border-gray-300'
                              )}
                            >
                              {allSelected && <Check className="w-3 h-3 text-white" />}
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            {sources.map((source) => {
                              const isSelected = selectedSourceIds.includes(source.id)
                              return (
                                <button
                                  key={source.id}
                                  onClick={() => toggleSource(source.id)}
                                  className={cn(
                                    'flex items-center gap-2 px-2 py-2 rounded-lg border text-left transition-all',
                                    isSelected
                                      ? 'border-red-500 bg-red-50'
                                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                                  )}
                                >
                                  <span className="text-lg">{source.icon || '📰'}</span>
                                  <span className={cn(
                                    'text-xs font-medium truncate flex-1',
                                    isSelected ? 'text-red-700' : 'text-gray-700'
                                  )}>
                                    {source.name}
                                  </span>
                                  {isSelected && <Check className="w-3 h-3 text-red-500 flex-shrink-0" />}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  
                  {/* 按钮组 */}
                  <div className="space-y-3 pt-2">
                    <button
                      onClick={() => setStep(3)}
                      disabled={selectedCount === 0}
                      className={cn(
                        'w-full py-3 px-4 bg-red-500 text-white rounded-lg font-medium',
                        'hover:bg-red-600 active:bg-red-700 transition-colors',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        'flex items-center justify-center gap-2'
                      )}
                    >
                      下一步
                      <ArrowRight className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => setStep(1)}
                      className="w-full py-3 px-4 text-gray-600 hover:text-gray-900 transition-colors"
                    >
                      返回修改
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-gray-900">确认信息</h2>
                <p className="text-gray-500 mt-1">这是你的公开资料</p>
              </div>
              
              {/* 预览 */}
              <div className="flex flex-col items-center gap-4">
                <div className="w-24 h-24 bg-red-100 rounded-full flex items-center justify-center text-5xl">
                  {selectedAvatar}
                </div>
                <div className="text-center">
                  <p className="text-lg font-semibold text-gray-900">
                    {nickname || `用户${Math.random().toString(36).substring(2, 8)}`}
                  </p>
                  <p className="text-sm text-gray-500 mt-1">
                    已选择 {selectedCount} 个新闻源
                  </p>
                </div>
              </div>
              
              {/* 按钮组 */}
              <div className="space-y-3">
                <button
                  onClick={handleLogin}
                  className={cn(
                    'w-full py-3 px-4 bg-red-500 text-white rounded-lg font-medium',
                    'hover:bg-red-600 active:bg-red-700 transition-colors'
                  )}
                >
                  开始使用
                </button>
                <button
                  onClick={() => setStep(2)}
                  className="w-full py-3 px-4 text-gray-600 hover:text-gray-900 transition-colors"
                >
                  返回修改
                </button>
              </div>
            </div>
          )}
        </div>
        
        {/* 底部说明 */}
        <p className="text-center text-sm text-gray-500 mt-6">
          无需注册，自动创建设备ID登录
        </p>
      </div>
    </div>
  )
}
