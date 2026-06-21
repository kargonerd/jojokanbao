import { useState, useRef } from 'react'
import { useUserStore } from '@/stores/userStore'
import { useRSSStore } from '@/stores/rssStore'
import { X, User, Camera, Upload, Loader2, Globe, Cpu, DollarSign, Check } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { RSSSource } from '@/types'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  activeTab?: 'profile' | 'sources' | 'account'
  onTabChange?: (tab: 'profile' | 'sources' | 'account') => void
}

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

export function SettingsModal({ isOpen, onClose, activeTab: externalActiveTab, onTabChange }: SettingsModalProps) {
  const { user, updateProfile, logout } = useUserStore()
  const { 
    availableSources, 
    selectedSourceIds, 
    toggleSource, 
    setSources
  } = useRSSStore()
  const [nickname, setNickname] = useState(user?.nickname || '')
  const [selectedAvatar, setSelectedAvatar] = useState(user?.avatar || '👤')
  const [internalActiveTab, setInternalActiveTab] = useState<'profile' | 'sources' | 'account'>('profile')
  
  const activeTab = externalActiveTab ?? internalActiveTab
  const setActiveTab = (tab: 'profile' | 'sources' | 'account') => {
    setInternalActiveTab(tab)
    onTabChange?.(tab)
  }
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [customAvatarUrl, setCustomAvatarUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!isOpen || !user) return null

  // 按分类分组
  const groupedSources = availableSources.reduce<Record<string, RSSSource[]>>((acc, source) => {
    const cat = source.category || '其他'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(source)
    return acc
  }, {})

  const selectedCount = selectedSourceIds.length

  const handleSave = () => {
    // 如果有自定义头像URL，使用它；否则使用emoji
    const avatarToSave = customAvatarUrl || selectedAvatar
    updateProfile(nickname, avatarToSave)
    onClose()
  }

  const handleLogout = () => {
    logout()
    onClose()
    window.location.href = '/login'
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // 验证文件类型
    if (!file.type.startsWith('image/')) {
      setUploadError('请选择图片文件')
      return
    }

    // 验证文件大小（5MB）
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('图片大小不能超过5MB')
      return
    }

    setIsUploading(true)
    setUploadError('')

    try {
      const formData = new FormData()
      formData.append('image', file)

      const response = await fetch('/api/upload-avatar', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || '上传失败')
      }

      const data = await response.json()
      setCustomAvatarUrl(data.url)
      setSelectedAvatar('') // 清除emoji选择
    } catch (error) {
      console.error('上传头像失败:', error)
      setUploadError(error instanceof Error ? error.message : '上传失败')
    } finally {
      setIsUploading(false)
    }
  }

  const handleEmojiSelect = (emoji: string) => {
    setSelectedAvatar(emoji)
    setCustomAvatarUrl(null) // 清除自定义头像
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* 背景遮罩 */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* 弹窗内容 */}
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">设置</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* 标签页 */}
        <div className="flex border-b border-gray-100">
          <button
            onClick={() => setActiveTab('profile')}
            className={cn(
              'flex-1 px-4 py-3 text-sm font-medium transition-colors',
              activeTab === 'profile'
                ? 'text-red-500 border-b-2 border-red-500'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            个人资料
          </button>
          <button
            onClick={() => setActiveTab('sources')}
            className={cn(
              'flex-1 px-4 py-3 text-sm font-medium transition-colors',
              activeTab === 'sources'
                ? 'text-red-500 border-b-2 border-red-500'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            新闻源
            {selectedCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 bg-red-500 text-white text-xs rounded-full">
                {selectedCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('account')}
            className={cn(
              'flex-1 px-4 py-3 text-sm font-medium transition-colors',
              activeTab === 'account'
                ? 'text-red-500 border-b-2 border-red-500'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            账号管理
          </button>
        </div>

        {/* 内容区域 */}
        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {activeTab === 'profile' ? (
            <div className="space-y-6">
              {/* 头像上传区域 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  头像
                </label>
                
                {/* 当前头像显示 */}
                <div className="flex items-center gap-4 mb-4">
                  <div className="relative">
                    {customAvatarUrl ? (
                      <img
                        src={customAvatarUrl}
                        alt="头像"
                        className="w-20 h-20 rounded-full object-cover border-2 border-red-500"
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center text-4xl border-2 border-red-500">
                        {selectedAvatar}
                      </div>
                    )}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                      className="absolute -bottom-1 -right-1 w-8 h-8 bg-red-500 text-white rounded-full flex items-center justify-center shadow-md hover:bg-red-600 transition-colors disabled:opacity-50"
                    >
                      {isUploading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Camera className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  
                  <div className="flex-1">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                      className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                    >
                      <Upload className="w-4 h-4" />
                      <span className="text-sm">上传图片</span>
                    </button>
                    <p className="mt-1 text-xs text-gray-500">
                      支持 JPG、PNG 格式，最大 5MB
                    </p>
                    {uploadError && (
                      <p className="mt-1 text-xs text-red-500">{uploadError}</p>
                    )}
                  </div>
                </div>
                
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>

              {/* 或者选择 Emoji */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  或选择 Emoji 头像
                </label>
                <div className="grid grid-cols-8 gap-2">
                  {AVATAR_OPTIONS.map((avatar) => (
                    <button
                      key={avatar}
                      onClick={() => handleEmojiSelect(avatar)}
                      className={cn(
                        'w-10 h-10 text-2xl flex items-center justify-center rounded-lg transition-all',
                        selectedAvatar === avatar && !customAvatarUrl
                          ? 'bg-red-100 ring-2 ring-red-500 scale-110'
                          : 'hover:bg-gray-100'
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
                  昵称
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="输入你的昵称"
                    className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                    maxLength={20}
                  />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {nickname.length}/20 字符
                </p>
              </div>

              {/* 设备ID显示 */}
              <div className="p-4 bg-gray-50 rounded-xl">
                <p className="text-xs text-gray-500 mb-1">设备ID</p>
                <p className="text-sm font-mono text-gray-700">{user.deviceId}</p>
              </div>
            </div>
          ) : activeTab === 'sources' ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-medium text-gray-700">
                  选择你感兴趣的新闻源
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSources(availableSources.map(s => s.id))}
                    className="text-xs text-red-500 hover:text-red-600 font-medium"
                  >
                    全选
                  </button>
                  <span className="text-gray-300">|</span>
                  <button
                    onClick={() => setSources([])}
                    className="text-xs text-gray-500 hover:text-gray-600 font-medium"
                  >
                    清空
                  </button>
                </div>
              </div>
              
              {availableSources.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p>正在加载新闻源...</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.entries(groupedSources).map(([category, sources]) => {
                    const CategoryIcon = categoryIcons[category] || Globe
                    const allSelected = sources.every(s => selectedSourceIds.includes(s.id))
                    const someSelected = sources.some(s => selectedSourceIds.includes(s.id))
                    
                    return (
                      <div key={category} className="border border-gray-100 rounded-xl p-3">
                        <div className="flex items-center gap-2 mb-3">
                          <CategoryIcon className="w-4 h-4 text-gray-400" />
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{category}</span>
                          <button
                            onClick={() => {
                              const categorySourceIds = sources.map(s => s.id)
                              if (allSelected) {
                                setSources(selectedSourceIds.filter(id => !categorySourceIds.includes(id)))
                              } else {
                                setSources([...new Set([...selectedSourceIds, ...categorySourceIds])])
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
                                  'flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-all',
                                  isSelected
                                    ? 'border-red-500 bg-red-50 shadow-sm'
                                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                                )}
                              >
                                <span className="text-lg">{source.icon || '📰'}</span>
                                <div className="flex-1 min-w-0">
                                  <p className={cn(
                                    'text-sm font-medium truncate',
                                    isSelected ? 'text-red-700' : 'text-gray-700'
                                  )}>
                                    {source.name}
                                  </p>
                                  <p className="text-xs text-gray-400 truncate">{source.country}</p>
                                </div>
                                {isSelected && <Check className="w-4 h-4 text-red-500 flex-shrink-0" />}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              
              <div className="mt-4 p-3 bg-gray-50 rounded-lg">
                <p className="text-xs text-gray-500">
                  已选择 <span className="font-medium text-red-500">{selectedCount}</span> 个新闻源
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 bg-yellow-50 border border-yellow-100 rounded-xl">
                <p className="text-sm text-yellow-800">
                  退出登录将清除当前设备的所有本地数据，但不会删除你的阅读记录。
                </p>
              </div>
              
              <button
                onClick={handleLogout}
                className="w-full py-3 px-4 bg-red-50 text-red-600 rounded-xl font-medium hover:bg-red-100 transition-colors"
              >
                退出登录
              </button>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        {activeTab === 'profile' && (
          <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
            <button
              onClick={onClose}
              className="flex-1 py-3 px-4 border border-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={isUploading}
              className="flex-1 py-3 px-4 bg-red-500 text-white rounded-xl font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              保存
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
