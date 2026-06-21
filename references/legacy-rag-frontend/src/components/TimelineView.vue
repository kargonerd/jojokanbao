<template>
  <div class="timeline-view">
    <div class="timeline-header">
      <h3>历史时间线</h3>
      <button class="close-btn" @click="$emit('close')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>
    </div>

    <div v-if="loading" class="timeline-loading">
      <div class="spinner"></div>
      <p>正在生成时间线...</p>
    </div>

    <div v-else-if="error" class="timeline-error">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="var(--accent-red)">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
      </svg>
      <p>{{ error }}</p>
      <button class="btn-secondary" @click="generateTimeline">重试</button>
    </div>

    <div v-else-if="timeline.length === 0" class="timeline-empty">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="var(--text-tertiary)">
        <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM9 10H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm-8 4H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/>
      </svg>
      <p>暂无时间线数据</p>
    </div>

    <div v-else class="timeline-content">
      <div class="timeline-filter">
        <input 
          v-model="filterText" 
          type="text" 
          placeholder="搜索事件..."
          class="filter-input"
        />
      </div>
      
      <div class="timeline">
        <div 
          v-for="(event, index) in filteredTimeline" 
          :key="index"
          class="timeline-item"
          :class="{ 'highlight': isHighlighted(event) }"
        >
          <div class="timeline-marker">
            <div class="timeline-dot"></div>
            <div v-if="index < filteredTimeline.length - 1" class="timeline-line"></div>
          </div>
          <div class="timeline-card">
            <div class="timeline-date">{{ formatDate(event.date) }}</div>
            <h4 class="timeline-title">{{ event.title }}</h4>
            <p class="timeline-description">{{ event.description }}</p>
            <div v-if="event.sources && event.sources.length > 0" class="timeline-sources">
              <span class="sources-label">来源：</span>
              <span 
                v-for="(source, sIndex) in event.sources" 
                :key="sIndex"
                class="source-tag"
              >
                {{ source }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// @ts-nocheck
import { ref, computed, onMounted } from 'vue'

interface TimelineEvent {
  date: string
  title: string
  description: string
  sources?: string[]
}

const props = defineProps<{
  notebookId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const loading = ref(true)
const error = ref('')
const timeline = ref<TimelineEvent[]>([])
const filterText = ref('')

const filteredTimeline = computed(() => {
  if (!filterText.value) return timeline.value
  const search = filterText.value.toLowerCase()
  return timeline.value.filter(event => 
    event.title.toLowerCase().includes(search) ||
    event.description.toLowerCase().includes(search)
  )
})

const isHighlighted = (event: TimelineEvent) => {
  if (!filterText.value) return false
  const search = filterText.value.toLowerCase()
  return event.title.toLowerCase().includes(search) ||
         event.description.toLowerCase().includes(search)
}

const formatDate = (date: string) => {
  if (!date) return '未知日期'
  
  // Handle different date formats
  if (date.includes('-')) {
    const parts = date.split('-')
    if (parts.length === 3) {
      return `${parts[0]}年${parts[1]}月${parts[2]}日`
    } else if (parts.length === 2) {
      return `${parts[0]}年${parts[1]}月`
    } else {
      return `${parts[0]}年`
    }
  }
  
  return date
}

const generateTimeline = async () => {
  loading.value = true
  error.value = ''
  
  try {
    const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:9002'
    const response = await fetch(`${API_BASE}/notebooks/${props.notebookId}/generate-timeline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
    
    const data = await response.json()
    
    if (data.success && data.data.timeline) {
      timeline.value = data.data.timeline
    } else {
      error.value = data.error || '生成时间线失败'
    }
  } catch (e) {
    error.value = '网络错误，请稍后重试'
    console.error('Failed to generate timeline:', e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  generateTimeline()
})
</script>

<style scoped>
.timeline-view {
  background: var(--bg-card);
  border-radius: 0;
  border: 1px solid var(--border-color);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 80vh;
}

.timeline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-body);
}

.timeline-header h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 0;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--border-color);
  color: var(--text-primary);
}

.timeline-loading,
.timeline-error,
.timeline-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  gap: 16px;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border-color);
  border-top-color: var(--primary-color);
  border-radius: 0;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.timeline-error p,
.timeline-empty p {
  color: var(--text-secondary);
  text-align: center;
}

.timeline-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.timeline-filter {
  margin-bottom: 20px;
}

.filter-input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 0;
  font-size: 14px;
  background: var(--bg-body);
  color: var(--text-primary);
}

.filter-input:focus {
  outline: none;
  border-color: var(--primary-color);
}

.timeline {
  position: relative;
}

.timeline-item {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
}

.timeline-item.highlight .timeline-card {
  border-color: var(--primary-color);
  background: rgba(158, 19, 27, 0.05);
}

.timeline-marker {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
}

.timeline-dot {
  width: 14px;
  height: 14px;
  background: var(--primary-color);
  border-radius: 0;
  border: 3px solid var(--bg-card);
  box-shadow: 0 0 0 2px var(--primary-color);
}

.timeline-line {
  width: 2px;
  flex: 1;
  background: var(--border-color);
  margin-top: 8px;
}

.timeline-card {
  flex: 1;
  background: var(--bg-body);
  border: 1px solid var(--border-color);
  border-radius: 0;
  padding: 16px;
  transition: all 0.2s;
}

.timeline-card:hover {
  border-color: var(--primary-color);
  box-shadow: 0 4px 12px rgba(158, 19, 27, 0.1);
}

.timeline-date {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary-color);
  margin-bottom: 6px;
}

.timeline-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
  line-height: 1.4;
}

.timeline-description {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 12px;
}

.timeline-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.sources-label {
  font-size: 12px;
  color: var(--text-tertiary);
}

.source-tag {
  font-size: 11px;
  padding: 3px 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 0;
  color: var(--text-secondary);
}

.btn-secondary {
  padding: 10px 20px;
  background: var(--bg-body);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 0;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background: var(--border-color);
}

/* Scrollbar styling */
.timeline-content::-webkit-scrollbar {
  width: 8px;
}

.timeline-content::-webkit-scrollbar-track {
  background: var(--bg-body);
  border-radius: 0;
}

.timeline-content::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: 0;
}

.timeline-content::-webkit-scrollbar-thumb:hover {
  background: var(--text-tertiary);
}
</style>
