<template>
  <div class="section-analyzer">
    <!-- Section List Panel -->
    <div v-if="showPanel" class="analyzer-panel">
      <div class="panel-header">
        <h3>📖 章节分析</h3>
        <button class="close-btn" @click="$emit('close')">×</button>
      </div>
      
      <div class="panel-content">
        <!-- Section List -->
        <div class="section-list">
          <div
            v-for="section in sections"
            :key="section.index"
            class="section-item"
            :class="{ active: currentSection?.index === section.index, analyzed: hasAnalysis(section.index) }"
            @click="selectSection(section)"
          >
            <div class="section-title">{{ section.title }}</div>
            <div class="section-meta">
              <span class="chapter">{{ section.chapter }}</span>
              <span v-if="hasAnalysis(section.index)" class="analyzed-badge">已分析</span>
            </div>
          </div>
        </div>
        
        <!-- Analysis Result -->
        <div v-if="currentAnalysis" class="analysis-result">
          <div class="result-header">
            <h4>{{ currentAnalysis.section_title }}</h4>
            <button class="refresh-btn" @click="refreshAnalysis" :disabled="analyzing">
              {{ analyzing ? '分析中...' : '🔄 重新分析' }}
            </button>
          </div>
          
          <!-- Summary -->
          <div class="summary-section">
            <h5>📝 内容总结</h5>
            <p>{{ currentAnalysis.summary }}</p>
          </div>
          
          <!-- Key Points -->
          <div class="keypoints-section">
            <h5>🔑 要点</h5>
            <ul>
              <li v-for="(point, i) in currentAnalysis.key_points" :key="i">{{ point }}</li>
            </ul>
          </div>
          
          <!-- Persons -->
          <div v-if="currentAnalysis.persons?.length" class="persons-section">
            <h5>👥 人物 ({{ currentAnalysis.persons.length }})</h5>
            <div class="person-list">
              <div
                v-for="person in currentAnalysis.persons"
                :key="person.name"
                class="person-card"
                :class="{ 'is-new': person.is_new }"
              >
                <div class="person-header">
                  <span class="person-name">{{ person.name }}</span>
                  <span v-if="person.aliases?.length" class="aliases">
                    ({{ person.aliases.join('、') }})
                  </span>
                  <span v-if="person.is_new" class="new-badge">新</span>
                </div>
                <div class="person-role">{{ person.role_in_section }}</div>
                <div class="person-actions">
                  <span v-for="(action, i) in person.actions" :key="i" class="action-tag">
                    {{ action }}
                  </span>
                </div>
                <div class="person-stats">
                  <span class="mention-count">提及 {{ person.mentioned_count }} 次</span>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Events -->
          <div v-if="currentAnalysis.events?.length" class="events-section">
            <h5>📅 事件 ({{ currentAnalysis.events.length }})</h5>
            <div class="event-list">
              <div
                v-for="event in currentAnalysis.events"
                :key="event.name"
                class="event-card"
              >
                <div class="event-header">
                  <span class="event-name">{{ event.name }}</span>
                  <span v-if="event.date" class="event-date">{{ event.date }}</span>
                </div>
                <div class="event-location" v-if="event.location">📍 {{ event.location }}</div>
                <div class="event-desc">{{ event.description }}</div>
                <div class="event-participants">
                  <span>参与者:</span>
                  <span v-for="p in event.participants" :key="p" class="participant-tag">{{ p }}</span>
                </div>
                <div class="event-significance">💡 {{ event.significance }}</div>
              </div>
            </div>
          </div>
          
          <!-- Historical Contexts -->
          <div v-if="currentAnalysis.historical_contexts?.length" class="context-section">
            <h5>📚 历史背景</h5>
            <div class="context-list">
              <div
                v-for="ctx in currentAnalysis.historical_contexts"
                :key="ctx.person_name"
                class="context-card"
              >
                <div class="context-person">{{ ctx.person_name }}</div>
                <div class="context-summary">{{ ctx.context_summary }}</div>
                <div class="previous-events">
                  <div
                    v-for="(evt, i) in ctx.previous_events"
                    :key="i"
                    class="previous-event"
                  >
                    <span class="evt-time">{{ evt.time }}</span>
                    <span class="evt-name">{{ evt.event }}</span>
                    <span class="evt-relation">→ {{ evt.relation }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div v-else-if="currentSection" class="no-analysis">
          <p>尚未分析此小节</p>
          <button class="analyze-btn" @click="analyzeCurrentSection" :disabled="analyzing">
            {{ analyzing ? 'AI分析中...' : '🔍 开始分析' }}
          </button>
        </div>
        
        <div v-else class="select-prompt">
          <p>👈 请从左侧选择一个小节进行分析</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

interface PersonInSection {
  name: string
  aliases: string[]
  role_in_section: string
  actions: string[]
  mentioned_count: number
  is_new: boolean
}

interface EventInSection {
  name: string
  date?: string
  description: string
  participants: string[]
  location?: string
  significance: string
}

interface HistoricalContext {
  person_name: string
  previous_events: Array<{
    event: string
    time: string
    relation: string
  }>
  context_summary: string
}

interface SectionAnalysis {
  section_title: string
  section_index: number
  chapter_title: string
  summary: string
  key_points: string[]
  persons: PersonInSection[]
  events: EventInSection[]
  historical_contexts: HistoricalContext[]
}

interface Section {
  index: number
  title: string
  level: number
  chapter: string
  preview: string
  content?: string
}

const props = defineProps<{
  showPanel: boolean
  bookId: string
}>()

const emit = defineEmits<{
  close: []
  'section-select': [section: Section]
}>()

const sections = ref<Section[]>([])
const currentSection = ref<Section | null>(null)
const analyses = ref<Map<number, SectionAnalysis>>(new Map())
const analyzing = ref(false)
const loading = ref(false)

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:9002'

const currentAnalysis = computed(() => {
  if (!currentSection.value) return null
  return analyses.value.get(currentSection.value.index) || null
})

function hasAnalysis(index: number): boolean {
  return analyses.value.has(index)
}

// Load sections
async function loadSections() {
  loading.value = true
  try {
    const res = await fetch(`${API_BASE}/api/books/${props.bookId}/sections`)
    const data = await res.json()
    if (data.success) {
      sections.value = data.data
    }
  } catch (e) {
    console.error('Failed to load sections:', e)
  } finally {
    loading.value = false
  }
}

// Select section
async function selectSection(section: Section) {
  currentSection.value = section
  emit('section-select', section)
  
  // If not analyzed, auto analyze
  if (!hasAnalysis(section.index)) {
    await analyzeCurrentSection()
  }
}

// Analyze current section
async function analyzeCurrentSection() {
  if (!currentSection.value || analyzing.value) return
  
  analyzing.value = true
  try {
    const res = await fetch(
      `${API_BASE}/api/books/${props.bookId}/sections/${currentSection.value.index}/analyze`,
      { method: 'POST' }
    )
    const data = await res.json()
    if (data.success) {
      analyses.value.set(currentSection.value.index, data.data)
    }
  } catch (e) {
    console.error('Failed to analyze section:', e)
  } finally {
    analyzing.value = false
  }
}

// Refresh analysis
async function refreshAnalysis() {
  if (currentSection.value) {
    analyses.value.delete(currentSection.value.index)
    await analyzeCurrentSection()
  }
}

// Load sections when panel opens
watch(() => props.showPanel, (newVal) => {
  if (newVal && sections.value.length === 0) {
    loadSections()
  }
})
</script>

<style scoped>
.section-analyzer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
}

.analyzer-panel {
  width: 480px;
  height: 100%;
  background: white;
  border-left: 1px solid #e0e0e0;
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #e0e0e0;
  background: #f8f9fa;
}

.panel-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: #666;
}

.panel-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* Section List */
.section-list {
  width: 180px;
  border-right: 1px solid #e0e0e0;
  overflow-y: auto;
  background: #fafafa;
}

.section-item {
  padding: 12px 16px;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f0;
  transition: all 0.2s;
}

.section-item:hover {
  background: #f0f0f0;
}

.section-item.active {
  background: #9e131b;
  color: white;
}

.section-item.active .chapter {
  color: rgba(255, 255, 255, 0.7);
}

.section-item.analyzed:not(.active) {
  border-left: 3px solid #4caf50;
}

.section-title {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 4px;
  line-height: 1.4;
}

.section-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chapter {
  font-size: 11px;
  color: #999;
}

.analyzed-badge {
  font-size: 10px;
  padding: 2px 6px;
  background: #4caf50;
  color: white;
  border-radius: 0;
}

/* Analysis Result */
.analysis-result {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 2px solid #e0e0e0;
}

.result-header h4 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.refresh-btn {
  padding: 6px 12px;
  background: #f5f5f5;
  border: 1px solid #e0e0e0;
  border-radius: 0;
  font-size: 12px;
  cursor: pointer;
}

.refresh-btn:hover:not(:disabled) {
  background: #e0e0e0;
}

.refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Summary */
.summary-section,
.keypoints-section,
.persons-section,
.events-section,
.context-section {
  margin-bottom: 24px;
}

.summary-section h5,
.keypoints-section h5,
.persons-section h5,
.events-section h5,
.context-section h5 {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin: 0 0 12px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.summary-section p {
  font-size: 14px;
  line-height: 1.7;
  color: #555;
  margin: 0;
}

/* Key Points */
.keypoints-section ul {
  margin: 0;
  padding-left: 20px;
}

.keypoints-section li {
  font-size: 13px;
  line-height: 1.6;
  color: #555;
  margin-bottom: 6px;
}

/* Persons */
.person-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.person-card {
  padding: 12px;
  background: #f8f9fa;
  border-radius: 0;
  border-left: 3px solid #9e131b;
}

.person-card.is-new {
  border-left-color: #4caf50;
  background: #f1f8e9;
}

.person-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.person-name {
  font-weight: 600;
  color: #333;
}

.aliases {
  font-size: 12px;
  color: #666;
}

.new-badge {
  font-size: 10px;
  padding: 2px 6px;
  background: #4caf50;
  color: white;
  border-radius: 0;
}

.person-role {
  font-size: 12px;
  color: #666;
  margin-bottom: 8px;
}

.person-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.action-tag {
  font-size: 11px;
  padding: 3px 8px;
  background: white;
  border-radius: 0;
  color: #555;
}

.person-stats {
  font-size: 11px;
  color: #999;
}

/* Events */
.event-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.event-card {
  padding: 12px;
  background: #f8f9fa;
  border-radius: 0;
  border-left: 3px solid #1e88e5;
}

.event-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.event-name {
  font-weight: 600;
  color: #333;
}

.event-date {
  font-size: 12px;
  color: #1e88e5;
  font-weight: 500;
}

.event-location {
  font-size: 12px;
  color: #666;
  margin-bottom: 6px;
}

.event-desc {
  font-size: 13px;
  line-height: 1.5;
  color: #555;
  margin-bottom: 8px;
}

.event-participants {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
}

.participant-tag {
  padding: 2px 8px;
  background: white;
  border-radius: 0;
  font-size: 11px;
}

.event-significance {
  font-size: 12px;
  color: #666;
  font-style: italic;
}

/* Historical Contexts */
.context-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.context-card {
  padding: 12px;
  background: #fff8e1;
  border-radius: 0;
  border-left: 3px solid #ff9800;
}

.context-person {
  font-weight: 600;
  color: #333;
  margin-bottom: 6px;
}

.context-summary {
  font-size: 13px;
  line-height: 1.5;
  color: #555;
  margin-bottom: 10px;
}

.previous-events {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.previous-event {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 6px 8px;
  background: white;
  border-radius: 0;
}

.evt-time {
  color: #999;
  min-width: 80px;
}

.evt-name {
  color: #333;
  flex: 1;
}

.evt-relation {
  color: #ff9800;
  font-size: 11px;
}

/* Empty States */
.no-analysis,
.select-prompt {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  text-align: center;
  color: #999;
}

.no-analysis p,
.select-prompt p {
  margin-bottom: 16px;
}

.analyze-btn {
  padding: 10px 24px;
  background: #9e131b;
  color: white;
  border: none;
  border-radius: 0;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.analyze-btn:hover:not(:disabled) {
  background: #b71c1c;
}

.analyze-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
