import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, ReadHistoryItem, FavoriteItem } from '@/types'
import { getOrCreateDeviceId } from '@/utils/deviceId'

interface UserState {
  user: User | null
  isLoggedIn: boolean
  preferredSourceIds: string[]
  readHistory: ReadHistoryItem[]
  favorites: FavoriteItem[]
  
  login: (nickname?: string, avatar?: string) => void
  updateProfile: (nickname?: string, avatar?: string) => void
  setPreferredSources: (sourceIds: string[]) => void
  
  // 阅读记录
  markAsRead: (newsId: string, newsTitle: string, sourceName: string) => void
  markAsUnread: (newsId: string) => void
  isRead: (newsId: string) => boolean
  getReadHistory: () => ReadHistoryItem[]
  clearReadHistory: () => void
  
  // 收藏功能
  addToFavorites: (newsId: string, newsTitle: string, sourceName: string, link: string) => void
  removeFromFavorites: (newsId: string) => void
  isFavorite: (newsId: string) => boolean
  getFavorites: () => FavoriteItem[]
  
  logout: () => void
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      user: null,
      isLoggedIn: false,
      preferredSourceIds: [],
      readHistory: [],
      favorites: [],
      
      login: (nickname, avatar) => {
        const deviceId = getOrCreateDeviceId()
        const user: User = {
          deviceId,
          nickname: nickname || `用户${deviceId.slice(-6)}`,
          avatar,
          createdAt: new Date().toISOString(),
        }
        set({ user, isLoggedIn: true })
      },
      
      updateProfile: (nickname, avatar) => {
        const { user } = get()
        if (user) {
          set({
            user: {
              ...user,
              nickname: nickname || user.nickname,
              avatar: avatar || user.avatar,
            },
          })
        }
      },
      
      setPreferredSources: (sourceIds: string[]) => {
        set({ preferredSourceIds: sourceIds })
      },
      
      // 阅读记录
      markAsRead: (newsId, newsTitle, sourceName) => {
        const { readHistory } = get()
        const existingIndex = readHistory.findIndex(item => item.newsId === newsId)
        
        if (existingIndex === -1) {
          // 新阅读记录
          const newItem: ReadHistoryItem = {
            newsId,
            newsTitle,
            sourceName,
            readAt: new Date().toISOString(),
            readCount: 1,
          }
          set({ readHistory: [newItem, ...readHistory].slice(0, 1000) }) // 最多保存1000条
        } else {
          // 更新已有记录
          const updated = [...readHistory]
          updated[existingIndex] = {
            ...updated[existingIndex],
            readAt: new Date().toISOString(),
            readCount: updated[existingIndex].readCount + 1,
          }
          set({ readHistory: updated })
        }
      },
      
      markAsUnread: (newsId) => {
        const { readHistory } = get()
        set({ readHistory: readHistory.filter(item => item.newsId !== newsId) })
      },
      
      isRead: (newsId) => {
        return get().readHistory.some(item => item.newsId === newsId)
      },
      
      getReadHistory: () => {
        return get().readHistory
      },
      
      clearReadHistory: () => {
        set({ readHistory: [] })
      },
      
      // 收藏功能
      addToFavorites: (newsId, newsTitle, sourceName, link) => {
        const { favorites } = get()
        if (!favorites.some(item => item.newsId === newsId)) {
          const newItem: FavoriteItem = {
            newsId,
            newsTitle,
            sourceName,
            link,
            favoritedAt: new Date().toISOString(),
          }
          set({ favorites: [newItem, ...favorites] })
        }
      },
      
      removeFromFavorites: (newsId) => {
        const { favorites } = get()
        set({ favorites: favorites.filter(item => item.newsId !== newsId) })
      },
      
      isFavorite: (newsId) => {
        return get().favorites.some(item => item.newsId === newsId)
      },
      
      getFavorites: () => {
        return get().favorites
      },
      
      logout: () => {
        set({ user: null, isLoggedIn: false })
      },
    }),
    {
      name: 'user-storage',
    }
  )
)
