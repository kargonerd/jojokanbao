import { ref } from 'vue'
import { catalogApi } from '../api'
import type { PersonEvents, PersonSummary, RelationsGraph, TimelineEvent } from '../types'

export type ReaderPanel = 'reader' | 'annotations' | 'persons' | 'timeline' | 'relations' | null

export function useReaderAnalysis() {
  const loadingPersons = ref(false)
  const loadingTimeline = ref(false)
  const loadingRelations = ref(false)
  const panelError = ref('')
  const persons = ref<PersonSummary[]>([])
  const selectedPersonEvents = ref<PersonEvents | null>(null)
  const timeline = ref<TimelineEvent[]>([])
  const relations = ref<RelationsGraph>({ nodes: [], links: [] })
  const activePanel = ref<ReaderPanel>(null)

  function togglePanel(panel: ReaderPanel) {
    activePanel.value = activePanel.value === panel ? null : panel
    panelError.value = ''
  }

  function resetAnalysisState() {
    selectedPersonEvents.value = null
    panelError.value = ''
    activePanel.value = null
    persons.value = []
    timeline.value = []
    relations.value = { nodes: [], links: [] }
  }

  async function loadPersons(notebookId: string, sourceId: string) {
    loadingPersons.value = true
    try {
      persons.value = await catalogApi.getPersons(notebookId, sourceId)
    } catch {
      persons.value = []
    } finally {
      loadingPersons.value = false
    }
  }

  async function loadPersonEvents(notebookId: string, sourceId: string, personName: string) {
    try {
      selectedPersonEvents.value = await catalogApi.getPersonEvents(notebookId, sourceId, personName)
    } catch {
      selectedPersonEvents.value = null
    }
  }

  async function togglePersons(notebookId: string, sourceId: string) {
    togglePanel('persons')
    if (activePanel.value === 'persons' && persons.value.length === 0) {
      await loadPersons(notebookId, sourceId)
    }
  }

  async function toggleTimeline(notebookId: string, sourceId: string) {
    togglePanel('timeline')
    if (activePanel.value === 'timeline' && timeline.value.length === 0) {
      loadingTimeline.value = true
      try {
        timeline.value = await catalogApi.getTimeline(notebookId, sourceId)
      } catch {
        timeline.value = []
        panelError.value = '时间线生成失败'
      } finally {
        loadingTimeline.value = false
      }
    }
  }

  async function toggleRelations(notebookId: string, sourceId: string) {
    togglePanel('relations')
    if (activePanel.value === 'relations' && relations.value.nodes.length === 0) {
      loadingRelations.value = true
      try {
        relations.value = await catalogApi.getRelations(notebookId, sourceId)
      } catch {
        relations.value = { nodes: [], links: [] }
        panelError.value = '关系摘要生成失败'
      } finally {
        loadingRelations.value = false
      }
    }
  }

  return {
    loadingPersons,
    loadingTimeline,
    loadingRelations,
    panelError,
    persons,
    selectedPersonEvents,
    timeline,
    relations,
    activePanel,
    togglePanel,
    resetAnalysisState,
    loadPersonEvents,
    togglePersons,
    toggleTimeline,
    toggleRelations,
  }
}
