<template>
  <div class="admin-page">
    <div class="page-header">
      <div>
        <h2>文库管理</h2>
        <p>按文库逐个配置</p>
      </div>
    </div>

    <div class="card ui-card">
      <div class="card-title">文库列表</div>
      <div v-if="notebooks.length === 0" class="empty-state ui-state-card">暂无文库</div>
      <div v-else class="library-grid">
        <button
          v-for="notebook in notebooks"
          :key="notebook.id"
          class="library-card"
          type="button"
          @click="openNotebook(notebook.id)"
        >
          <div class="cover">
            <img
              v-if="notebook.cover_url && !brokenCovers[notebook.id]"
              :src="notebook.cover_url"
              :alt="notebook.title"
              @error="markCoverBroken(notebook.id)"
            >
            <div v-else class="placeholder">{{ notebook.title.slice(0, 1) }}</div>
          </div>
          <div class="info">
            <h3>{{ notebook.title }}</h3>
            <p>{{ notebook.description || '暂无描述' }}</p>
            <div class="meta">
              <span>排序 {{ notebook.sort_order || 0 }}</span>
              <span>{{ notebook.source_count || 0 }} 个 sources</span>
            </div>
            <div class="status">
              <span class="badge ui-badge" :class="{ ok: notebook.publish_ready }">
                {{ notebook.publish_ready ? '可发布' : '未完成' }}
              </span>
              <span class="badge ui-badge" :class="{ ok: notebook.is_published }">
                {{ notebook.is_published ? '已发布' : '未发布' }}
              </span>
            </div>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminCatalogApi } from '../api'
import type { Notebook } from '../types'

const router = useRouter()
const notebooks = ref<Notebook[]>([])
const brokenCovers = ref<Record<string, boolean>>({})

async function loadNotebooks() {
  notebooks.value = await adminCatalogApi.listNotebooks()
}

function openNotebook(notebookId: string) {
  router.push(`/admin/libraries/${notebookId}`)
}

function markCoverBroken(notebookId: string) {
  brokenCovers.value = {
    ...brokenCovers.value,
    [notebookId]: true,
  }
}

onMounted(loadNotebooks)
</script>

<style scoped>
.admin-page { display: flex; flex-direction: column; gap: 18px; width: 100%; }
.page-header h2 { font-size: 30px; letter-spacing: 0.02em; }
.page-header p { margin-top: 8px; color: var(--text-secondary); }
.card { padding: 18px 20px; border-radius: 0; background: rgba(255,251,245,.68); border: 1px solid rgba(157,22,28,.2); box-shadow: none; }
.card-title { margin-bottom: 14px; font-size: 17px; font-weight: 700; }
.library-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 10px; align-items: start; }
.library-card { display: grid; grid-template-rows: auto 1fr; border: 1px solid rgba(157,22,28,.18); border-radius: 0; overflow: hidden; background: rgba(255,251,245,.78); cursor: pointer; text-align: left; min-width: 0; }
.cover { aspect-ratio: 2.2 / 1; min-height: 0; background: linear-gradient(180deg, rgba(157,22,28,.08), rgba(255,251,245,.28)); }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.placeholder { width: 100%; height: 100%; display: grid; place-items: center; color: var(--primary-color); font-size: clamp(34px, 3vw, 48px); font-weight: 700; }
.info { padding: 12px 12px 10px; }
.info h3 { font-size: 14px; line-height: 1.4; }
.info p { margin-top: 4px; color: var(--text-secondary); font-size: 12px; min-height: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.meta, .status { display: flex; justify-content: space-between; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.meta { color: var(--text-secondary); font-size: 11px; }
.badge { padding: 3px 7px; border-radius: 0; background: rgba(157,22,28,.05); color: var(--text-secondary); font-size: 10px; font-weight: 600; border: 1px solid rgba(157,22,28,.12); }
.badge.ok { background: rgba(22,163,74,.08); color: #15803d; border-color: rgba(21,128,61,.16); }
.empty-state { padding: 24px; text-align: center; color: var(--text-secondary); }

@media (max-width: 1400px) {
  .card { padding: 16px; }
  .library-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px; }
}

@media (max-width: 1100px) {
  .library-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); }
}

@media (max-width: 900px) {
  .admin-page { width: 100%; }
  .card { padding: 14px; }
  .library-grid { grid-template-columns: 1fr; gap: 12px; }
}
</style>
