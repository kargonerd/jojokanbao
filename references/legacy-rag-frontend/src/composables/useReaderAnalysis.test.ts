import { describe, expect, it, vi } from 'vitest'
import { useReaderAnalysis } from './useReaderAnalysis'
import { catalogApi } from '../api'

vi.mock('../api', () => ({
  catalogApi: {
    getPersons: vi.fn(),
    getPersonEvents: vi.fn(),
    getTimeline: vi.fn(),
    getRelations: vi.fn(),
  },
}))

const mockedCatalogApi = vi.mocked(catalogApi)

describe('useReaderAnalysis', () => {
  it('loads persons lazily when opening the persons panel', async () => {
    mockedCatalogApi.getPersons.mockResolvedValue([{ id: 'p1', name: '毛泽东', mention_count: 3 }])

    const analysis = useReaderAnalysis()
    await analysis.togglePersons('nb-1', 'src-1')

    expect(analysis.activePanel.value).toBe('persons')
    expect(analysis.persons.value[0].name).toBe('毛泽东')
  })

  it('isolates timeline failures in the side panel', async () => {
    mockedCatalogApi.getTimeline.mockRejectedValue(new Error('failed'))

    const analysis = useReaderAnalysis()
    await analysis.toggleTimeline('nb-1', 'src-1')

    expect(analysis.activePanel.value).toBe('timeline')
    expect(analysis.timeline.value).toEqual([])
    expect(analysis.panelError.value).toBe('时间线生成失败')
    expect(analysis.loadingTimeline.value).toBe(false)
  })

  it('resets analysis state when switching documents', async () => {
    mockedCatalogApi.getRelations.mockResolvedValue({ nodes: [{ id: 'p1', name: '人物' }], links: [] })

    const analysis = useReaderAnalysis()
    await analysis.toggleRelations('nb-1', 'src-1')
    analysis.resetAnalysisState()

    expect(analysis.activePanel.value).toBeNull()
    expect(analysis.relations.value).toEqual({ nodes: [], links: [] })
  })
})
