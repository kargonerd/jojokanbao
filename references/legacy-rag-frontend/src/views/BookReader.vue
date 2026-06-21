<template>
  <div class="book-reader" :class="`theme-${readerPrefs.theme}`">
    <header class="reader-header">
      <button class="back-btn" @click="goBack">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
        </svg>
        返回聊天
      </button>
      <div class="book-title">{{ sourceTitle || String(route.params.sourceId || '') }}</div>
      <div class="header-actions">
        <button class="action-btn" :class="{ active: activePanel === 'reader' }" @click="togglePanel('reader')">阅读</button>
        <button v-if="annotations.length" class="action-btn" :class="{ active: activePanel === 'annotations' }" @click="togglePanel('annotations')">
          注解 {{ visibleAnnotations.length }}
        </button>
        <button class="action-btn" :class="{ active: activePanel === 'persons' }" @click="togglePersons">人物</button>
        <button class="action-btn" :class="{ active: activePanel === 'timeline' }" @click="toggleTimeline">时间线</button>
        <button class="action-btn" :class="{ active: activePanel === 'relations' }" @click="toggleRelations">关系</button>
      </div>
    </header>

    <div class="reader-layout" :class="{ compact: !activePanel }">
      <aside v-if="tableOfContents.length > 0 || chapterList.length > 0" class="toc-sidebar">
        <div class="toc-header">目录</div>
        <nav class="toc-nav">
          <button
            v-for="item in tableOfContents"
            :key="item.id"
            class="toc-item"
            :class="{ active: activeHeading === item.id || activeChapterId === item.chapter_id, [`level-${item.level || 1}`]: true }"
            @click="handleTocSelect(item)"
          >
            {{ item.title }}
          </button>
        </nav>

        <div v-if="chapterList.length > 0 && tableOfContents.length === 0" class="toc-section">
          <div class="toc-subheader">章节</div>
          <button
            v-for="chapter in chapterList"
            :key="chapter.id"
            class="toc-item chapter-item"
            :class="{ active: activeChapterId === chapter.id }"
            @click="loadChapter(chapter.id)"
          >
            {{ chapter.title }}
          </button>
        </div>
      </aside>

      <main class="content-wrapper">
        <div v-if="loadingDocument" class="state-box ui-state-card">正在加载文档...</div>
        <div v-else-if="error" class="state-box ui-state-card error">{{ error }}</div>
        <div v-else-if="loadingChapter" class="state-box ui-state-card">正在切换章节...</div>
        <article
          v-else
          class="content-container markdown-body"
          :style="readerStyle"
          v-html="renderedContent"
        ></article>
      </main>

      <aside v-if="activePanel === 'reader'" class="side-panel">
        <div class="panel-header">
          <h3>阅读设置</h3>
          <button class="close-btn" @click="activePanel = null">×</button>
        </div>
        <div class="panel-body control-list">
          <label class="control-item">
            <span>字号</span>
            <input v-model.number="readerPrefs.fontSize" type="range" min="14" max="28" step="1">
            <strong>{{ readerPrefs.fontSize }}px</strong>
          </label>
          <label class="control-item">
            <span>行高</span>
            <input v-model.number="readerPrefs.lineHeight" type="range" min="1.4" max="2.2" step="0.1">
            <strong>{{ readerPrefs.lineHeight.toFixed(1) }}</strong>
          </label>
          <label class="control-item">
            <span>内容宽度</span>
            <select v-model="readerPrefs.contentWidth">
              <option value="760px">舒适</option>
              <option value="900px">偏宽</option>
              <option value="1040px">通栏</option>
            </select>
          </label>
          <label class="control-item">
            <span>主题</span>
            <select v-model="readerPrefs.theme">
              <option value="paper">纸页</option>
              <option value="light">明亮</option>
              <option value="dark">暗色</option>
            </select>
          </label>
        </div>
      </aside>

      <aside v-if="activePanel === 'persons'" class="side-panel">
        <div class="panel-header">
          <h3>人物索引</h3>
          <button class="close-btn" @click="activePanel = null">×</button>
        </div>
        <div v-if="panelError" class="panel-state error">{{ panelError }}</div>
        <div v-else-if="loadingPersons" class="panel-state">正在提取人物...</div>
        <div v-else-if="persons.length === 0" class="panel-state">暂无人物数据</div>
        <div v-else class="panel-body">
          <button
            v-for="person in persons"
            :key="person.id || person.name"
            class="person-item"
            @click="loadPersonEvents(person.name)"
          >
            <span>{{ person.name }}</span>
            <small>{{ person.mention_count || 0 }} 次</small>
          </button>

          <div v-if="selectedPersonEvents" class="detail-card">
            <h4>{{ selectedPersonEvents.person }}</h4>
            <p>{{ selectedPersonEvents.full_profile || '暂无简介' }}</p>
            <div v-for="(event, index) in selectedPersonEvents.events" :key="index" class="detail-item">
              <strong>{{ event.name }}</strong>
              <span>{{ event.date || '时间未知' }}</span>
              <p>{{ event.description || '暂无描述' }}</p>
            </div>
          </div>
        </div>
      </aside>

      <aside v-if="activePanel === 'timeline'" class="side-panel">
        <div class="panel-header">
          <h3>时间线</h3>
          <button class="close-btn" @click="activePanel = null">×</button>
        </div>
        <div v-if="panelError" class="panel-state error">{{ panelError }}</div>
        <div v-else-if="loadingTimeline" class="panel-state">正在生成时间线...</div>
        <div v-else-if="timeline.length === 0" class="panel-state">暂无时间线数据</div>
        <div v-else class="panel-body">
          <div v-for="(item, index) in timeline" :key="index" class="detail-card">
            <strong>{{ item.title }}</strong>
            <span>{{ item.date || '时间未知' }}</span>
            <p>{{ item.description || '暂无描述' }}</p>
          </div>
        </div>
      </aside>

      <aside v-if="activePanel === 'relations'" class="side-panel">
        <div class="panel-header">
          <h3>关系摘要</h3>
          <button class="close-btn" @click="activePanel = null">×</button>
        </div>
        <div v-if="panelError" class="panel-state error">{{ panelError }}</div>
        <div v-else-if="loadingRelations" class="panel-state">正在生成关系图摘要...</div>
        <div v-else-if="relations.nodes.length === 0" class="panel-state">暂无关系数据</div>
        <div v-else class="panel-body">
          <div class="detail-card">
            <strong>人物 {{ relations.nodes.length }} 个</strong>
            <span>关系 {{ relations.links.length }} 条</span>
          </div>
          <div v-for="(link, index) in relations.links.slice(0, 20)" :key="index" class="detail-card">
            <strong>{{ link.source }} → {{ link.target }}</strong>
            <p>{{ link.relation || '相关联' }}</p>
          </div>
        </div>
      </aside>

      <aside v-if="activePanel === 'annotations'" class="side-panel annotation-panel">
        <div class="panel-header">
          <h3>注解</h3>
        </div>
        <div class="panel-body">
          <div v-for="(annotation, index) in visibleAnnotations" :key="annotation.id || index" class="detail-card">
            <strong>{{ annotation.quote || annotation.anchor || '注解' }}</strong>
            <p>{{ annotation.note || '暂无内容' }}</p>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useReaderAnalysis } from '../composables/useReaderAnalysis'
import { useReaderDocument } from '../composables/useReaderDocument'
import type { SourceTocItem } from '../types'

const route = useRoute()
const router = useRouter()

const documentState = useReaderDocument()
const analysisState = useReaderAnalysis()

const {
  sourceTitle,
  loadingDocument,
  loadingChapter,
  error,
  activeHeading,
  activeChapterId,
  tableOfContents,
  chapterList,
  annotations,
  readerPrefs,
  readerStyle,
  visibleAnnotations,
  renderedContent,
} = documentState

const {
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
} = analysisState

function routeIds() {
  return {
    notebookId: route.params.notebookId as string,
    sourceId: route.params.sourceId as string,
  }
}

function loadChapter(chapterId: string) {
  const { notebookId, sourceId } = routeIds()
  return documentState.loadChapter(notebookId, sourceId, chapterId)
}

function loadPersonEvents(personName: string) {
  const { notebookId, sourceId } = routeIds()
  return analysisState.loadPersonEvents(notebookId, sourceId, personName)
}

function togglePersons() {
  const { notebookId, sourceId } = routeIds()
  return analysisState.togglePersons(notebookId, sourceId)
}

function toggleTimeline() {
  const { notebookId, sourceId } = routeIds()
  return analysisState.toggleTimeline(notebookId, sourceId)
}

function toggleRelations() {
  const { notebookId, sourceId } = routeIds()
  return analysisState.toggleRelations(notebookId, sourceId)
}

function scrollToHeading(id: string) {
  const element = document.getElementById(id)
  if (!element) return
  element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activeHeading.value = id
}

function handleTocSelect(item: SourceTocItem) {
  if (item.chapter_id) {
    void loadChapter(item.chapter_id)
    return
  }
  if (item.id) {
    scrollToHeading(item.id)
  }
}

function goBack() {
  router.push('/chat')
}

watch(
  () => [route.params.notebookId, route.params.sourceId],
  async () => {
    const { notebookId, sourceId } = routeIds()
    analysisState.resetAnalysisState()
    await documentState.loadDocument(notebookId, sourceId)
  },
  { immediate: true },
)
</script>

<style scoped>
.book-reader {
  min-height: 100vh;
  background:
    radial-gradient(circle at top left, rgba(158, 19, 27, 0.08), transparent 22%),
    linear-gradient(180deg, #fbf8f7 0%, #f4efee 100%);
}

.book-reader.theme-light {
  background: linear-gradient(180deg, #fffdf9 0%, #f8f4ec 100%);
}

.book-reader.theme-dark {
  --text-primary: #f7efe7;
  --text-secondary: #d8c8be;
  --text-tertiary: #bdaaa0;
  --bg-card: #211917;
  --border-color: rgba(247, 239, 231, 0.22);
  --border-strong: rgba(247, 239, 231, 0.38);
  background: linear-gradient(180deg, #1c1513 0%, #120e0d 100%);
}

.reader-header {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 18px;
  padding: 20px 24px;
  border-bottom: 1px solid rgba(158, 19, 27, 0.08);
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(14px);
}

.back-btn,
.action-btn,
.close-btn,
.toc-item,
.person-item {
  border: none;
  cursor: pointer;
  font: inherit;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-radius: 0;
  background: #fff;
  box-shadow: inset 0 0 0 1px rgba(158, 19, 27, 0.08);
}

.book-title {
  font-size: 22px;
  font-weight: 700;
}

.header-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.action-btn {
  padding: 10px 14px;
  border-radius: 0;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: inset 0 0 0 1px rgba(158, 19, 27, 0.08);
}

.action-btn.active {
  background: linear-gradient(135deg, var(--primary-color), #c52b31);
  color: #fff;
}

.reader-layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 340px;
  gap: 20px;
  padding: 20px;
}

.reader-layout.compact {
  grid-template-columns: 240px minmax(0, 1fr);
}

.toc-sidebar,
.content-container,
.side-panel,
.state-box {
  border-radius: 0;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid rgba(158, 19, 27, 0.08);
  box-shadow: 0 24px 50px rgba(54, 32, 32, 0.08);
}

.toc-sidebar,
.side-panel {
  padding: 18px;
  align-self: start;
  position: sticky;
  top: 20px;
}

.toc-header,
.toc-subheader {
  font-weight: 700;
  margin-bottom: 12px;
}

.toc-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(158, 19, 27, 0.08);
}

.toc-nav,
.panel-body,
.control-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toc-item,
.person-item {
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border-radius: 0;
  background: rgba(250, 245, 244, 0.9);
}

.toc-item.active,
.person-item:hover {
  background: rgba(197, 43, 49, 0.12);
}

.toc-item.level-2 { padding-left: 24px; }
.toc-item.level-3 { padding-left: 36px; }

.content-wrapper {
  min-width: 0;
}

.content-container {
  padding: 28px;
  margin: 0 auto;
}

.content-container :deep(img) {
  max-width: 100%;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.close-btn {
  width: 32px;
  height: 32px;
  border-radius: 0;
  background: rgba(0, 0, 0, 0.06);
}

.panel-state {
  color: var(--text-secondary);
}

.panel-state.error {
  color: var(--danger-color);
}

.detail-card,
.detail-item {
  padding: 12px 14px;
  border-radius: 0;
  background: rgba(250, 245, 244, 0.92);
}

.detail-item p,
.detail-card p {
  margin: 8px 0 0;
}

.control-item {
  display: grid;
  gap: 8px;
}

.control-item select,
.control-item input[type='range'] {
  width: 100%;
}

.state-box {
  padding: 24px;
}

.state-box.error {
  color: #b42318;
}

.annotation-panel {
  grid-column: 3;
}

@media (max-width: 1280px) {
  .reader-layout,
  .reader-layout.compact {
    grid-template-columns: 1fr;
  }

  .toc-sidebar,
  .side-panel,
  .annotation-panel {
    position: static;
    grid-column: auto;
  }
}
</style>
