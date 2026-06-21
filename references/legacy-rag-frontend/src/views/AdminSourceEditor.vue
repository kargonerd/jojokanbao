<template>
  <div class="editor-page">
    <div class="page-header">
      <button class="ghost-btn ui-btn ui-btn-secondary" @click="router.push(`/admin/libraries/${route.params.notebookId}`)">返回文库</button>
      <div class="header-actions">
        <button class="ui-btn ui-btn-secondary" @click="reload">刷新</button>
        <button class="ui-btn ui-btn-primary" @click="saveSource" :disabled="saving">
          {{ saving ? '保存中...' : '保存 Source' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="state-card ui-state-card">加载中...</div>
    <div v-else-if="!source" class="state-card ui-state-card">Source 不存在</div>
    <template v-else>
      <section class="card ui-card">
        <div class="card-header">
          <div>
            <h2>{{ source.title }}</h2>
            <p>{{ source.kind || 'source' }}</p>
          </div>
          <label class="switch-row" :class="{ disabled: !source.publish_ready }">
            <span>前台发布</span>
            <button class="switch" :class="{ on: form.is_published }" type="button" @click="togglePublish">
              <span></span>
            </button>
          </label>
        </div>

        <div v-if="!source.publish_ready" class="warning-box">
          当前不能发布：{{ formatPublishReasons(source.publish_reasons) }}
        </div>

        <div class="cover-row">
          <div class="cover-box">
            <img v-if="source.cover_url" :src="source.cover_url" :alt="source.title">
            <div v-else class="cover-placeholder">封面</div>
          </div>
          <div class="cover-actions">
            <label class="ui-btn ui-btn-secondary">
              上传封面
              <input type="file" hidden accept="image/*" @change="handleCoverChange">
            </label>
          </div>
        </div>

        <div class="form-grid">
          <label class="form-group ui-form-group">
            <span>展示标题</span>
            <input v-model="form.display_title" type="text">
          </label>
          <label class="form-group ui-form-group">
            <span>排序</span>
            <input v-model.number="form.sort_order" type="number">
          </label>
          <label class="form-group form-group-full">
            <span>描述</span>
            <textarea v-model="form.description" rows="4"></textarea>
          </label>
        </div>
      </section>

      <section class="card ui-card">
        <div class="card-header">
          <div>
            <h3>文档绑定</h3>
            <p>支持 Markdown 直传，或导入 jojo-press 生成的结构化 zip 包。</p>
          </div>
        </div>

        <div class="upload-grid">
          <div class="upload-panel primary-path">
            <div class="upload-panel-header">
              <h4>结构化导入包</h4>
              <span class="ui-badge ok">推荐</span>
            </div>
            <p>导入 jojo-press 生成的 ZIP 包，保留目录、章节、注解和阅读设置。</p>
            <div class="upload-box">
              <label class="ui-btn ui-btn-primary">
                选择 ZIP 包
                <input type="file" hidden accept=".zip,application/zip" @change="handlePackageChange">
              </label>
              <span class="file-name">{{ formatFileLabel(pendingPackage) }}</span>
            </div>
          </div>

          <div class="upload-panel">
            <div class="upload-panel-header">
              <h4>Markdown 直传</h4>
              <span class="ui-badge">兼容</span>
            </div>
            <p>用于老文档或临时文本绑定，不包含结构化章节元数据。</p>
            <div class="upload-box">
              <label class="ui-btn ui-btn-secondary">
                选择 Markdown
                <input type="file" hidden accept=".md,text/markdown" @change="handleDocumentChange">
              </label>
              <span class="file-name">{{ formatFileLabel(pendingMarkdown) }}</span>
            </div>
          </div>
        </div>

        <div class="doc-status">
          <span class="badge ui-badge" :class="{ ok: source.has_document }">{{ source.has_document ? '已绑定文档' : '未绑定文档' }}</span>
          <span>{{ source.document_status || 'missing' }}</span>
          <span v-if="source.document_mode">模式：{{ source.document_mode }}</span>
          <span v-if="source.chapter_count">章节：{{ source.chapter_count }}</span>
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
import type { Source } from '../types'

const route = useRoute()
const router = useRouter()
const source = ref<Source | null>(null)
const loading = ref(true)
const saving = ref(false)
const pendingMarkdown = ref<File | null>(null)
const pendingPackage = ref<File | null>(null)
const { toast, showToast } = useToast()

const form = reactive({
  display_title: '',
  description: '',
  is_published: false,
  sort_order: 0,
})

function syncForm() {
  if (!source.value) return
  form.display_title = source.value.title || ''
  form.description = source.value.description || ''
  form.is_published = Boolean(source.value.is_published)
  form.sort_order = source.value.sort_order || 0
}

async function loadData() {
  loading.value = true
  try {
    const notebookId = route.params.notebookId as string
    const sourceId = route.params.sourceId as string
    const list = await adminCatalogApi.listSources(notebookId)
    source.value = list.find(item => item.id === sourceId) || null
    syncForm()
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
  if (!source.value?.publish_ready) return
  form.is_published = !form.is_published
}

function formatFileLabel(file: File | null) {
  if (!file) {
    return '未选择文件'
  }
  const size = file.size >= 1024 * 1024
    ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(file.size / 1024))} KB`
  return `${file.name} · ${size}`
}

function handleDocumentChange(event: Event) {
  pendingMarkdown.value = (event.target as HTMLInputElement).files?.[0] || null
}

function handlePackageChange(event: Event) {
  pendingPackage.value = (event.target as HTMLInputElement).files?.[0] || null
}

async function handleCoverChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    await adminCatalogApi.uploadSourceCover(route.params.notebookId as string, route.params.sourceId as string, file)
    await loadData()
    showToast('封面已上传')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '上传封面失败', 'error')
  }
}

async function saveSource() {
  saving.value = true
  try {
    const notebookId = route.params.notebookId as string
    const sourceId = route.params.sourceId as string
    await adminCatalogApi.updateSource(notebookId, sourceId, { ...form })
    if (pendingMarkdown.value) {
      await adminCatalogApi.uploadSourceDocument(notebookId, sourceId, {
        markdown: pendingMarkdown.value,
        title: form.display_title,
      })
      pendingMarkdown.value = null
    }
    if (pendingPackage.value) {
      await adminCatalogApi.importSourcePackage(notebookId, sourceId, pendingPackage.value)
      pendingPackage.value = null
    }
    await loadData()
    showToast('Source 已保存')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.editor-page { display: flex; flex-direction: column; gap: 18px; }
.page-header, .card-header, .cover-row, .header-actions, .doc-status { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.card, .state-card { padding: 22px; }
.switch { border: none; font: inherit; cursor: pointer; }
.switch-row { display: flex; align-items: center; gap: 12px; }
.switch-row.disabled { opacity: .5; }
.switch { width: 54px; height: 32px; border-radius: 0; background: #ddd; padding: 4px; }
.switch span { display: block; width: 24px; height: 24px; border-radius: 0; background: #fff; transition: transform .2s ease; }
.switch.on { background: #16a34a; }
.switch.on span { transform: translateX(22px); }
.warning-box { margin-top: 14px; padding: 12px 14px; border: 1px solid rgba(146, 64, 14, .22); background: rgba(234,179,8,.1); color: #92400e; }
.cover-row { margin-top: 18px; align-items: flex-start; }
.cover-box { width: 180px; height: 240px; overflow: hidden; background: linear-gradient(135deg,#f0d8d4,#faf5f4); border: 1px solid var(--border-color); }
.cover-box img { width: 100%; height: 100%; object-fit: cover; }
.cover-placeholder { width: 100%; height: 100%; display: grid; place-items: center; color: var(--text-secondary); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 18px; }
.form-group { display: flex; flex-direction: column; gap: 8px; }
.form-group-full { grid-column: 1 / -1; }
.upload-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 14px; }
.upload-panel { padding: 16px; background: rgba(250,245,244,.72); border: 1px solid rgba(158,19,27,.16); }
.upload-panel.primary-path { border-color: rgba(21,128,61,.24); background: rgba(240,253,244,.28); }
.upload-panel-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; }
.upload-panel h4 { margin: 0; }
.upload-panel p { margin-bottom: 12px; color: var(--text-secondary); font-size: 13px; }
.upload-box { display: flex; align-items: center; gap: 12px; }
.file-name { color: var(--text-secondary); overflow-wrap: anywhere; }
@media (max-width: 900px) { .page-header, .card-header, .cover-row, .upload-box, .doc-status { flex-direction: column; align-items: stretch; } .form-grid, .upload-grid { grid-template-columns: 1fr; } }
</style>
