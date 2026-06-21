<template>
  <div 
    v-if="visible" 
    class="person-card-popup"
    :style="{ top: position.y + 'px', left: position.x + 'px' }"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <!-- Loading State -->
    <div v-if="loading" class="card-loading">
      <div class="spinner"></div>
      <span>AI分析中...</span>
    </div>
    
    <!-- Person Events Data -->
    <div v-else-if="personData" class="card-content">
      <!-- Header -->
      <div class="card-header">
        <h4 class="person-name">{{ personData.person }}</h4>
        <button class="close-btn" @click="$emit('hide')">×</button>
      </div>
      
      <!-- Full Profile -->
      <div class="profile-section">
        <p class="profile-text">{{ personData.full_profile }}</p>
      </div>
      
      <!-- Events Timeline -->
      <div v-if="personData.events?.length" class="events-section">
        <h5>📅 事件时间线 ({{ personData.events.length }})</h5>
        <div class="timeline">
          <div
            v-for="(event, index) in personData.events"
            :key="index"
            class="timeline-item"
          >
            <div class="timeline-marker"></div>
            <div class="timeline-content">
              <div class="event-header">
                <span class="event-name">{{ event.name }}</span>
                <span v-if="event.date" class="event-date">{{ event.date }}</span>
              </div>
              <div v-if="event.chapter" class="event-chapter">📖 {{ event.chapter }}</div>
              <p class="event-desc">{{ event.description }}</p>
              <div v-if="event.participants?.length" class="event-participants">
                <span>参与者:</span>
                <span 
                  v-for="p in event.participants" 
                  :key="p"
                  class="participant-tag"
                  @click.stop="$emit('select-person', p)"
                >{{ p }}</span>
              </div>
              <div class="event-significance">💡 {{ event.significance }}</div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Role Changes -->
      <div v-if="personData.role_changes?.length" class="roles-section">
        <h5>👤 身份变化</h5>
        <div class="role-list">
          <div
            v-for="(role, index) in personData.role_changes"
            :key="index"
            class="role-item"
          >
            <span class="role-time">{{ role.time }}</span>
            <span class="role-title">{{ role.role }}</span>
            <span class="role-context">{{ role.context }}</span>
          </div>
        </div>
      </div>
      
      <!-- Relationships -->
      <div v-if="personData.relationships?.length" class="relationships-section">
        <h5>🔗 人物关系</h5>
        <div class="relationship-list">
          <div
            v-for="(rel, index) in personData.relationships"
            :key="index"
            class="relationship-item"
            @click="$emit('select-person', rel.person)"
          >
            <span class="rel-person">{{ rel.person }}</span>
            <span class="rel-type">{{ rel.relationship }}</span>
            <span class="rel-context">{{ rel.context }}</span>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Error State -->
    <div v-else class="card-error">
      <p>无法加载人物信息</p>
      <button class="retry-btn" @click="loadPersonData">重试</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

interface PersonEvent {
  name: string
  date?: string
  chapter?: string
  description: string
  participants?: string[]
  significance: string
}

interface RoleChange {
  time: string
  role: string
  context: string
}

interface Relationship {
  person: string
  relationship: string
  context: string
}

interface PersonData {
  person: string
  full_profile: string
  events: PersonEvent[]
  role_changes: RoleChange[]
  relationships: Relationship[]
}

const props = defineProps<{
  visible: boolean
  personName: string
  position: { x: number; y: number }
  bookId: string
  notebookId?: string
}>()

const emit = defineEmits<{
  'select-person': [name: string]
  'hide': []
}>()

const personData = ref<PersonData | null>(null)
const loading = ref(false)
const hideTimeout = ref<number | null>(null)

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:9002'

// Load person data when visible changes
watch(() => props.visible, async (newVisible) => {
  if (newVisible && props.personName) {
    await loadPersonData()
  }
})

async function loadPersonData() {
  loading.value = true
  personData.value = null
  
  try {
    // Build URL with notebook_id if available
    let url = `${API_BASE}/api/books/${props.bookId}/persons/${encodeURIComponent(props.personName)}/events`
    if (props.notebookId) {
      url += `?notebook_id=${props.notebookId}`
    }
    
    const res = await fetch(url)
    const data = await res.json()
    
    if (data.success && data.data) {
      personData.value = data.data
    }
  } catch (e) {
    console.error('Failed to load person events:', e)
  } finally {
    loading.value = false
  }
}

function onMouseEnter() {
  if (hideTimeout.value) {
    clearTimeout(hideTimeout.value)
    hideTimeout.value = null
  }
}

function onMouseLeave() {
  hideTimeout.value = window.setTimeout(() => {
    emit('hide')
  }, 300)
}
</script>

<style scoped>
.person-card-popup {
  position: fixed;
  z-index: 10000;
  width: 420px;
  max-height: 600px;
  background: white;
  border-radius: 0;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  border: 1px solid #e0e0e0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.card-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 12px;
  color: #666;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid #e0e0e0;
  border-top-color: #9e131b;
  border-radius: 0;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.card-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.person-name {
  font-size: 18px;
  font-weight: 600;
  color: #333;
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  font-size: 20px;
  color: #999;
  cursor: pointer;
}

.close-btn:hover {
  color: #333;
}

/* Profile Section */
.profile-section {
  margin-bottom: 16px;
  padding: 12px;
  background: #f8f9fa;
  border-radius: 0;
}

.profile-text {
  font-size: 14px;
  line-height: 1.6;
  color: #555;
  margin: 0;
}

/* Events Section */
.events-section,
.roles-section,
.relationships-section {
  margin-bottom: 20px;
}

.events-section h5,
.roles-section h5,
.relationships-section h5 {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin: 0 0 12px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}

/* Timeline */
.timeline {
  position: relative;
  padding-left: 20px;
}

.timeline::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #e0e0e0;
}

.timeline-item {
  position: relative;
  padding-bottom: 16px;
}

.timeline-marker {
  position: absolute;
  left: -20px;
  top: 4px;
  width: 12px;
  height: 12px;
  background: #9e131b;
  border-radius: 0;
  border: 2px solid white;
  box-shadow: 0 0 0 2px #9e131b;
}

.timeline-content {
  padding-left: 8px;
}

.event-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.event-name {
  font-weight: 600;
  color: #333;
  font-size: 14px;
}

.event-date {
  font-size: 12px;
  color: #9e131b;
  font-weight: 500;
}

.event-chapter {
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
  margin-bottom: 6px;
  font-size: 12px;
}

.participant-tag {
  padding: 2px 8px;
  background: #f0f0f0;
  border-radius: 0;
  cursor: pointer;
  transition: background 0.2s;
}

.participant-tag:hover {
  background: #e0e0e0;
}

.event-significance {
  font-size: 12px;
  color: #666;
  font-style: italic;
}

/* Role List */
.role-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.role-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: #f8f9fa;
  border-radius: 0;
  font-size: 13px;
}

.role-time {
  color: #9e131b;
  font-weight: 500;
  min-width: 80px;
}

.role-title {
  color: #333;
  font-weight: 500;
  min-width: 120px;
}

.role-context {
  color: #666;
  flex: 1;
}

/* Relationship List */
.relationship-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.relationship-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: #f8f9fa;
  border-radius: 0;
  cursor: pointer;
  transition: background 0.2s;
}

.relationship-item:hover {
  background: #e8f4f8;
}

.rel-person {
  color: #9e131b;
  font-weight: 600;
  min-width: 80px;
}

.rel-type {
  color: #333;
  font-weight: 500;
  min-width: 80px;
}

.rel-context {
  color: #666;
  font-size: 12px;
  flex: 1;
}

/* Error State */
.card-error {
  padding: 40px 20px;
  text-align: center;
  color: #999;
}

.card-error p {
  margin-bottom: 16px;
}

.retry-btn {
  padding: 8px 20px;
  background: #9e131b;
  color: white;
  border: none;
  border-radius: 0;
  cursor: pointer;
  font-size: 14px;
}

.retry-btn:hover {
  background: #b71c1c;
}
</style>
