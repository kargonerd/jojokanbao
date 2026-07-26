import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { RSSSource, NewsItem } from '@/types'

// 默认RSS源配置
export const DEFAULT_SOURCES: RSSSource[] = [
  {
    id: 'zaobao-china',
    name: '联合早报 - 中国新闻',
    url: 'https://rsshub.app/zaobao/znews/china',
    category: '中国',
    description: '新加坡联合早报中国新闻版块',
    icon: '🇨🇳',
  },
  {
    id: 'zaobao-world',
    name: '联合早报 - 国际新闻',
    url: 'https://rsshub.app/zaobao/znews/world',
    category: '国际',
    description: '新加坡联合早报国际新闻版块',
    icon: '🌍',
  },
]

interface RSSState {
  availableSources: RSSSource[]
  selectedSourceIds: string[]
  news: NewsItem[]
  isLoading: boolean
  error: string | null
  lastFetchTime: Record<string, string>
  
  setAvailableSources: (sources: RSSSource[]) => void
  toggleSource: (id: string) => void
  setSources: (ids: string[]) => void
  setNews: (news: NewsItem[]) => void
  setLoading: (isLoading: boolean) => void
  setError: (error: string | null) => void
  updateLastFetchTime: () => void
}

export const useRSSStore = create<RSSState>()(
  persist(
    (set, get) => ({
      availableSources: DEFAULT_SOURCES,
      selectedSourceIds: [DEFAULT_SOURCES[0]?.id],
      news: [],
      isLoading: false,
      error: null,
      lastFetchTime: {},
      
      setAvailableSources: (sources) => {
        set({ availableSources: sources })
      },
      
      toggleSource: (id) => {
        const { selectedSourceIds } = get()
        if (selectedSourceIds.includes(id)) {
          if (selectedSourceIds.length > 1) {
            set({ selectedSourceIds: selectedSourceIds.filter(s => s !== id) })
          }
        } else {
          set({ selectedSourceIds: [...selectedSourceIds, id] })
        }
      },
      
      setSources: (ids) => {
        set({ selectedSourceIds: ids })
      },
      
      setNews: (news) => {
        set({ news })
      },
      
      setLoading: (isLoading) => {
        set({ isLoading })
      },
      
      setError: (error) => {
        set({ error })
      },
      
      updateLastFetchTime: () => {
        set({ lastFetchTime: { all: new Date().toISOString() } })
      },
    }),
    {
      name: 'rss-storage',
      partialize: (state) => ({
        availableSources: state.availableSources,
        selectedSourceIds: state.selectedSourceIds,
        lastFetchTime: state.lastFetchTime,
      }),
    }
  )
)
