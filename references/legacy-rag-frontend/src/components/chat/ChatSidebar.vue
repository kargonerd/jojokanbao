<script setup lang="ts">
import Simplebar from 'simplebar-vue'
import 'simplebar-vue/dist/simplebar.min.css'
import type { Notebook, Source } from '../../types'

defineProps<{
  notebooks: Notebook[]
  selectedNotebook: Notebook | null
  sources: Source[]
  selectedSourceIds: string[]
  loadingNotebooks: boolean
}>()

const emit = defineEmits<{
  selectNotebook: [notebook: Notebook]
  selectSource: [sourceId: string]
  openSource: [source: Source]
  selectAllSources: []
}>()
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1 class="logo">
        <span class="brand-mark">JOJO读书</span>
      </h1>
      <p>在原有文库风格里继续做 Notebook 问答和 source 阅读。</p>
    </div>

    <section class="sidebar-section">
      <div class="section-header">
        <span>Notebook</span>
      </div>
      <div v-if="loadingNotebooks" class="sidebar-loading">
        <span class="spinner"></span>
      </div>
      <Simplebar v-else class="sidebar-scroll">
        <button
          v-for="notebook in notebooks"
          :key="notebook.id"
          class="sidebar-item"
          :class="{ active: selectedNotebook?.id === notebook.id }"
          type="button"
          @click="emit('selectNotebook', notebook)"
        >
          <span class="item-title">{{ notebook.title }}</span>
          <span class="item-meta">{{ notebook.source_count || 0 }} 个 source</span>
        </button>
      </Simplebar>
    </section>

    <section v-if="selectedNotebook" class="sidebar-section sources-panel">
      <div class="section-header">
        <span>Source</span>
        <button class="mini-btn" type="button" @click="emit('selectAllSources')">全选</button>
      </div>
      <Simplebar class="sidebar-scroll">
        <label
          v-for="source in sources"
          :key="source.id"
          class="source-row"
        >
          <input
            type="checkbox"
            :checked="selectedSourceIds.includes(source.id)"
            @change="emit('selectSource', source.id)"
          >
          <button class="source-link" type="button" @click.prevent="emit('openSource', source)">
            {{ source.title }}
          </button>
        </label>
      </Simplebar>
      <p class="source-tip">未全选时，提问只会基于当前勾选的 sources。</p>
    </section>
  </aside>
</template>

<style scoped>
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(158, 19, 27, 0.08);
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(14px);
}

.sidebar-header {
  padding: 28px 24px 20px;
  border-bottom: 1px solid rgba(122, 82, 58, 0.14);
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--primary-color);
  font-size: 24px;
}

.sidebar-header p {
  margin-top: 10px;
  color: var(--text-secondary);
  font-size: 14px;
}

.sidebar-section {
  padding: 18px 16px;
  border-bottom: 1px solid rgba(158, 19, 27, 0.06);
}

.sources-panel {
  flex: 1;
  min-height: 0;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.sidebar-scroll {
  max-height: 32vh;
}

.sidebar-loading {
  display: flex;
  justify-content: center;
  padding: 24px 0 12px;
}

.spinner {
  width: 22px;
  height: 22px;
  border-radius: 0;
  border: 2px solid rgba(158, 19, 27, 0.15);
  border-top-color: var(--primary-color);
  animation: spin 0.8s linear infinite;
}

.sidebar-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  padding: 14px 15px;
  border: 1px solid rgba(158, 19, 27, 0.1);
  border-radius: 0;
  background: linear-gradient(180deg, #fff 0%, #fcf9f8 100%);
  cursor: pointer;
  transition: 0.2s ease;
}

.sidebar-item:hover,
.source-row:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 18px rgba(158, 19, 27, 0.08);
}

.sidebar-item.active {
  border-color: rgba(158, 19, 27, 0.32);
  background: linear-gradient(180deg, rgba(158, 19, 27, 0.08), rgba(158, 19, 27, 0.03));
}

.item-title {
  color: var(--text-primary);
  font-weight: 700;
  text-align: left;
}

.item-meta {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
}

.mini-btn,
.source-link {
  border: none;
  background: transparent;
}

.mini-btn {
  color: var(--primary-color);
  font-weight: 700;
  cursor: pointer;
}

.source-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  padding: 12px 14px;
  border: 1px solid rgba(158, 19, 27, 0.08);
  border-radius: 0;
  background: rgba(255, 255, 255, 0.88);
}

.source-link {
  flex: 1;
  text-align: left;
  color: var(--text-primary);
  cursor: pointer;
}

.source-tip {
  margin-top: 12px;
  color: var(--text-secondary);
  font-size: 12px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1024px) {
  .sidebar {
    position: static;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }

  .sidebar-scroll {
    max-height: 220px;
  }
}
</style>
