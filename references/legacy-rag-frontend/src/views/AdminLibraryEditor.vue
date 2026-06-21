<template>
  <div class="editor-page">
    <div class="page-header">
      <button class="ghost-btn ui-btn ui-btn-secondary" @click="router.push('/admin/libraries')">返回文库管理</button>
      <div class="header-actions">
        <button class="ui-btn ui-btn-secondary" @click="reload">刷新</button>
        <button class="ui-btn ui-btn-primary" @click="saveNotebook" :disabled="savingNotebook">
          {{ savingNotebook ? '保存中...' : '保存文库' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="state-card ui-state-card">加载中...</div>
    <div v-else-if="!notebook" class="state-card ui-state-card">文库不存在</div>
    <template v-else>
      <section class="card ui-card">
        <div class="card-header">
          <div>
            <h2>{{ notebook.title }}</h2>
            <p>文库配置</p>
          </div>
          <label class="switch-row" :class="{ disabled: !notebook.publish_ready }">
            <span>前台发布</span>
            <button class="switch" :class="{ on: notebookForm.is_published }" type="button" @click="togglePublish">
              <span></span>
            </button>
          </label>
        </div>

        <div v-if="!notebook.publish_ready" class="warning-box">
          当前不能发布：{{ formatPublishReasons(notebook.publish_reasons) }}
        </div>

        <div class="cover-row">
          <div class="cover-box">
            <img v-if="notebook.cover_url" :src="notebook.cover_url" :alt="notebook.title">
            <div v-else class="cover-placeholder">封面</div>
          </div>
          <div class="cover-actions">
            <label class="ui-btn ui-btn-secondary">
              上传封面
              <input type="file" hidden accept="image/*" @change="handleNotebookCoverChange">
            </label>
          </div>
        </div>

        <div class="form-grid">
          <label class="form-group ui-form-group">
            <span>展示标题</span>
            <input v-model="notebookForm.display_title" type="text">
          </label>
          <label class="form-group ui-form-group">
            <span>排序</span>
            <input v-model.number="notebookForm.sort_order" type="number">
          </label>
          <label class="form-group form-group-full">
            <span>描述</span>
            <textarea v-model="notebookForm.description" rows="4"></textarea>
          </label>
        </div>
      </section>

      <section class="card ui-card">
        <div class="card-header">
          <div>
            <h3>Source 列表</h3>
            <p>每个 source 单独进入配置页</p>
          </div>
        </div>

        <div v-if="sources.length === 0" class="state-card inner">暂无 source</div>
        <div v-else class="source-list">
          <button
            v-for="source in sources"
            :key="source.id"
            class="source-item"
            type="button"
            @click="openSource(source.id)"
          >
            <div>
              <div class="source-title">{{ source.title }}</div>
              <div class="source-meta">
                <span>{{ source.kind || 'source' }}</span>
                <span>{{ source.has_document ? '已绑定文档' : '未绑定文档' }}</span>
              </div>
            </div>
            <div class="source-status">
              <span class="badge ui-badge" :class="{ ok: source.publish_ready }">
                {{ source.publish_ready ? '可发布' : '未完成' }}
              </span>
            </div>
          </button>
        </div>
      </section>
    </template>

    <div v-if="toast" class="toast ui-toast" :class="toast.type">{{ toast.message }}</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { adminCatalogApi } from '../api'
import { useToast } from '../composables/useToast'
import { formatPublishReasons } from '../utils/publishReasons'
import type { Notebook, Source } from '../types'

const route = useRoute()
const router = useRouter()
const notebook = ref<Notebook | null>(null)
const sources = ref<Source[]>([])
const loading = ref(true)
const savingNotebook = ref(false)
const { toast, showToast } = useToast()

const notebookForm = reactive({
  display_title: '',
  description: '',
  is_published: false,
  sort_order: 0,
})

function syncForm() {
  if (!notebook.value) return
  notebookForm.display_title = notebook.value.title || ''
  notebookForm.description = notebook.value.description || ''
  notebookForm.is_published = Boolean(notebook.value.is_published)
  notebookForm.sort_order = notebook.value.sort_order || 0
}

async function loadData() {
  loading.value = true
  try {
    const notebookId = route.params.notebookId as string
    const all = await adminCatalogApi.listNotebooks()
    notebook.value = all.find(item => item.id === notebookId) || null
    if (!notebook.value) return
    syncForm()
    sources.value = await adminCatalogApi.listSources(notebookId)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载失败', 'error')
  } finally {
    loading.value = false
  }
}

async function reload() {
  await loadData()
}

function togglePublish() {
  if (!notebook.value?.publish_ready) return
  notebookForm.is_published = !notebookForm.is_published
}

async function saveNotebook() {
  const notebookId = route.params.notebookId as string
  savingNotebook.value = true
  try {
    await adminCatalogApi.updateNotebook(notebookId, { ...notebookForm })
    await loadData()
    showToast('文库已保存')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存失败', 'error')
  } finally {
    savingNotebook.value = false
  }
}

async function handleNotebookCoverChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const notebookId = route.params.notebookId as string
    await adminCatalogApi.uploadNotebookCover(notebookId, file)
    await loadData()
    showToast('封面已上传')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '上传封面失败', 'error')
  }
}

function openSource(sourceId: string) {
  router.push(`/admin/libraries/${route.params.notebookId}/sources/${sourceId}`)
}

onMounted(loadData)
</script>

<style scoped>
.editor-page { display: flex; flex-direction: column; gap: 18px; }
.page-header, .card-header, .cover-row, .header-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.card, .state-card { padding: 22px; }
.state-card.inner { text-align: center; color: var(--text-secondary); }
.switch, .source-item { border: none; font: inherit; cursor: pointer; }
.switch-row { display: flex; align-items: center; gap: 12px; }
.switch-row.disabled { opacity: .5; }
.switch { width: 54px; height: 32px; border-radius: 0; background: #ddd; padding: 4px; }
.switch span { display: block; width: 24px; height: 24px; border-radius: 0; background: #fff; transition: transform .2s ease; }
.switch.on { background: #16a34a; }
.switch.on span { transform: translateX(22px); }
.warning-box { margin-top: 14px; padding: 12px 14px; border: 1px solid rgba(146, 64, 14, .22); background: rgba(234, 179, 8, .1); color: #92400e; }
.cover-row { margin-top: 18px; align-items: flex-start; }
.cover-box { width: 180px; height: 240px; overflow: hidden; background: linear-gradient(135deg,#f0d8d4,#faf5f4); border: 1px solid var(--border-color); }
.cover-box img { width: 100%; height: 100%; object-fit: cover; }
.cover-placeholder { width: 100%; height: 100%; display: grid; place-items: center; color: var(--text-secondary); }
.cover-actions { flex: 1; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 18px; }
.form-group { display: flex; flex-direction: column; gap: 8px; }
.form-group-full { grid-column: 1 / -1; }
.source-list { display: flex; flex-direction: column; gap: 12px; }
.source-item { display: flex; justify-content: space-between; align-items: center; padding: 16px; background: rgba(255, 251, 245, .76); border: 1px solid var(--border-color); text-align: left; }
.source-item:hover { background: rgba(157, 22, 28, .04); }
.source-title { font-weight: 700; }
.source-meta { margin-top: 6px; display: flex; gap: 10px; color: var(--text-secondary); font-size: 13px; }
@media (max-width: 900px) { .page-header, .card-header, .cover-row { flex-direction: column; align-items: stretch; } .form-grid { grid-template-columns: 1fr; } }
</style>
