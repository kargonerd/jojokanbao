<template>
  <div ref="scrollbar" class="h-full overflow-y-auto bg-paper">
    <div id="viewer" class="px-4">
      <h1 class="hidden">{{ name }} - {{ date }}</h1>

      <!-- Toolbar: Magazine mode -->
      <div v-if="isMagazine()" class="flex flex-wrap items-center gap-4 py-3.5 px-4 border-b border-rule">
        <div class="flex items-center gap-2.5">
          <span class="text-[13px] font-bold text-muted tracking-wide">日期</span>
          <VueDatePicker
            :model-value="date"
            @update:model-value="handleYearPickerChange"
            year-picker
            :clearable="false"
            auto-apply
            locale="zh-CN"
            style="width: 120px"
          />
        </div>
        <div class="flex items-center gap-2.5">
          <span class="text-[13px] font-bold text-muted tracking-wide">期数</span>
          <select v-model="seq" class="h-8 text-sm min-w-[120px]" @change="handleOptionChange">
            <option v-for="item in seqOptions" :key="item" :value="item">{{ genSeqText(item) }}</option>
          </select>
          <a v-if="downloadURL" :href="downloadURL" target="_blank" class="ml-4 text-sm font-bold text-red hover:text-red-dark">下载</a>
        </div>
      </div>

      <!-- Toolbar: Newspaper mode -->
      <div v-else class="flex flex-wrap items-center gap-4 py-3.5 px-4 border-b border-rule">
        <div class="flex items-center gap-2.5">
          <span class="text-[13px] font-bold text-muted tracking-wide">日期</span>
          <VueDatePicker
            :model-value="formatDateForPicker(date)"
            @update:model-value="handlePickerDateChange"
            :enable-time-picker="false"
            :clearable="false"
            :disabled-dates="pickerOptions && pickerOptions.disabledDate ? pickerOptions.disabledDate : undefined"
            auto-apply
            locale="zh-CN"
            format="yyyy年MM月dd日"
            style="width: 175px"
          />
          <a v-if="downloadURL" :href="downloadURL" target="_blank" class="ml-4 text-sm font-bold text-red hover:text-red-dark">下载</a>
        </div>
      </div>

      <!-- Content -->
      <div>
        <div v-if="isNoData" class="py-20 text-center">
          <p class="text-muted font-bold">没有当天文档或数据缺失</p>
        </div>
        <div v-else class="w-full">
          <template v-for="item in pageItems">
            <div v-if="item.type === 'spacer'" :key="item.key" class="w-full" :style="{height:item.height+'px'}"></div>
            <div v-else :key="'pdf-page-' + item.pageNum" class="mb-6">
              <!-- Failed page -->
              <div v-if="isPageFailed(item.pageNum)" class="flex items-center justify-center" :style="{height:pageHeight+'px'}" :id="'page-error-'+item.pageNum">
                <div class="text-center">
                  <p class="text-lg text-ink mb-2">第 {{ item.pageNum }} 页加载失败</p>
                  <p class="text-sm text-muted mb-4">网络或渲染异常，可以单独重试本页</p>
                  <button class="btn btn-outline text-sm" @click.stop="handleRetryPage(item.pageNum)">重试本页</button>
                </div>
              </div>
              <!-- Rendered page -->
              <div v-else-if="isPageLoaded(item.pageNum) && fullPdfRenderSource" class="relative" :style="{minHeight: isPageLoading(item.pageNum) ? pageHeight + 'px' : null}">
                <pdf-page ref="pdfRef"
                  :id="'page-' + item.pageNum"
                  :source="fullPdfRenderSource"
                  :page="item.pageNum"
                  :scale="resolutionRate*2"
                  @rendered="handlePageRendered(item.pageNum)"
                  @rendering-failed="handlePageRenderFailed(item.pageNum)" />
                <div v-if="isPageLoading(item.pageNum)" class="absolute inset-0 flex items-center justify-center gap-2.5 bg-paper/85">
                  <div class="w-4 h-4 border-2 border-red border-t-transparent rounded-full animate-spin"></div>
                  <span class="text-sm text-ink">正在加载第 {{ item.pageNum }} 页</span>
                </div>
              </div>
              <!-- Lazy placeholder (viewport) -->
              <div v-else-if="fullPdfDocument && isViewportLazyLoadEnabled" class="flex items-center justify-center" :style="{height:pageHeight+'px'}" :id="'page-empty-'+item.pageNum" :data-page-num="item.pageNum">
                <div class="text-center">
                  <p class="text-lg text-ink mb-2">第 {{ item.pageNum }} 页</p>
                  <p class="text-sm text-muted mb-4">滚动到此处时加载</p>
                  <button class="btn btn-outline text-sm" @click.stop="handleManualPageLoad(item.pageNum)">加载本页</button>
                </div>
              </div>
              <!-- Lazy placeholder (sequential) -->
              <div v-else-if="fullPdfDocument" class="flex items-center justify-center" :style="{height:pageHeight+'px'}" :id="'page-empty-'+item.pageNum" :data-page-num="item.pageNum">
                <div class="text-center">
                  <p class="text-lg text-ink mb-2">第 {{ item.pageNum }} 页</p>
                  <p class="text-sm text-muted mb-4">目标页加载完成后再按需加载</p>
                  <button class="btn btn-outline text-sm" @click.stop="handleManualPageLoad(item.pageNum)">加载本页</button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Settings button (fixed) -->
    <div class="fixed right-10 top-[110px] z-50">
      <button
        class="w-9 h-9 flex items-center justify-center border border-rule-dark bg-paper text-ink hover:text-red hover:border-red transition-colors"
        @click="settingsOpen = !settingsOpen"
        aria-label="设置"
      >
        <svg class="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="8" cy="8" r="3"/><path d="M8 1v2m0 10v2m-7-7h2m10 0h2m-2.5-4.5-1.4 1.4m-7.2 7.2-1.4 1.4m0-10 1.4 1.4m7.2 7.2 1.4 1.4"/>
        </svg>
      </button>
      <!-- Settings panel -->
      <div v-if="settingsOpen" class="absolute right-0 top-11 w-[220px] border border-rule-dark bg-paper p-4 space-y-4 shadow-none">
        <div>
          <label class="block text-xs font-bold text-muted mb-2 tracking-wide">页面跳转</label>
          <div class="flex gap-2">
            <input type="number" v-model.number="jumpToPageNum" :min="1" :max="maxPageCount" class="h-8 w-16 text-sm text-center" />
            <button class="btn text-xs h-8" @click="handlePageChange(jumpToPageNum)">跳转</button>
          </div>
        </div>
        <div v-if="!isMagazine() && resolutionControl && downloadURL">
          <label class="block text-xs font-bold text-muted mb-2 tracking-wide">清晰度 ({{ resolutionRate }})</label>
          <input type="range" v-model.number="resolutionRate" min="1" max="5" step="1" class="w-full accent-red" @change="changeResolution" />
        </div>
      </div>
    </div>

    <!-- Back to top -->
    <button
      v-if="showBackTop"
      class="fixed right-10 bottom-10 w-10 h-10 flex items-center justify-center border border-rule-dark bg-paper text-red hover:bg-red hover:text-cream transition-colors z-50"
      @click="scrollToTop"
      aria-label="回到顶部"
    >
      <svg class="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 14V2m-5 5 5-5 5 5"/></svg>
    </button>
  </div>
</template>

<script>
import { getDocument, CMAP_URL, WASM_URL } from '@/pdfjs';
import { NEWSPAPER_HOST } from '@/constants';
import { markRaw } from 'vue';
import PdfPage from '@/components/PdfPage.vue';
import { VueDatePicker } from '@vuepic/vue-datepicker';
import {isThin} from "@/util";

export default {
  name: "DocViewer",
  components: { PdfPage, VueDatePicker },
  props: {
    pickerOptions: Object,
    defaultDate: String,
    name: String,
    type: String,
    resolutionControl: Boolean,
    fetchSeqOptions: Function,
    genSeqText: Function,
    enableTextLayer: Boolean,
  },
  data() {
    return {
      date: "",
      seq: 1,
      resolutionRate: window.innerWidth < 768 ? 1 : 2,
      downloadURL: '',
      fullPdfDocument: null,
      fullPdfRenderSource: null,
      fullPdfLoadingTask: null,
      renderedPages: [],
      pageLoadingPages: [],
      failedPages: [],
      isViewportLazyLoadEnabled: true,
      isNoData: false,
      jumpToPageNum: 1,
      maxPageCount: 1,
      goToPageAfterRendered: 0,
      hashchangeListener: null,
      resizeTimer: null,
      currentDocId: '',
      loadGeneration: 0,
      cachedPageHeight: 600,
      settingsOpen: false,
      showBackTop: false,
      loading: false,
    };
  },
  computed: {
    seqOptions() {
      if (!this.fetchSeqOptions) return []
      return this.fetchSeqOptions(this.date) || []
    },
    pageHeight() {
      return this.cachedPageHeight
    },
    pageItems() {
      if (!this.fullPdfDocument || this.isNoData) return []

      const visiblePages = new Set()
      const addPage = pageNum => {
        pageNum = Number(pageNum)
        if (pageNum >= 1 && pageNum <= this.maxPageCount) visiblePages.add(pageNum)
      }

      this.renderedPages.concat(this.failedPages).forEach(pageNum => {
        addPage(pageNum)
        if (this.isViewportLazyLoadEnabled) {
          addPage(pageNum - 2); addPage(pageNum - 1)
          addPage(pageNum + 1); addPage(pageNum + 2)
        }
      })

      if (this.goToPageAfterRendered) addPage(this.goToPageAfterRendered)
      if (!visiblePages.size && this.isViewportLazyLoadEnabled) addPage(1)

      const pageNums = Array.from(visiblePages).sort((a, b) => a - b)
      if (!pageNums.length) return []

      const items = []
      let prev = 0
      pageNums.forEach(pageNum => {
        const skipped = pageNum - prev - 1
        if (skipped > 0) {
          items.push({ type: 'spacer', key: `spacer-${prev+1}-${pageNum-1}`, height: skipped * (this.pageHeight + 24) })
        }
        items.push({ type: 'page', pageNum })
        prev = pageNum
      })

      const trailing = this.maxPageCount - prev
      if (trailing > 0) {
        items.push({ type: 'spacer', key: `spacer-${prev+1}-${this.maxPageCount}`, height: trailing * (this.pageHeight + 24) })
      }
      return items
    }
  },
  created() {
    this.$watch(
      () => this.$route.params,
      () => {
        const id = this.$route.params.id
        if (this.isMagazine()) {
          this.date = id.substring(0, 4)
          this.seq = parseInt(id.substring(4))
        } else {
          this.date = id
        }
        this.loadData()
      },
      { immediate: true }
    )
    this.hashchangeListener = () => {
      const hashPageNum = this.getHashPageNum()
      this.handlePageChange(hashPageNum)
    }
    window.addEventListener("hashchange", this.hashchangeListener)
    this.$watch('pageItems', () => { this._startObserving() })
  },
  mounted() {
    window.addEventListener('resize', this.handleWindowResize)
    this.$refs.scrollbar?.addEventListener('scroll', this.handleScroll)
    this._lazyObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) this.handlePageEnter(entry.target)
      })
    }, { rootMargin: '200px' })
    this._startObserving()
  },
  beforeUnmount() {
    window.removeEventListener("hashchange", this.hashchangeListener)
    window.removeEventListener('resize', this.handleWindowResize)
    this.$refs.scrollbar?.removeEventListener('scroll', this.handleScroll)
    if (this._lazyObserver) { this._lazyObserver.disconnect(); this._lazyObserver = null }
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); this.resizeTimer = null }
    this.cleanupFullPdfDocument()
  },
  methods: {
    formatDateForInput(dateStr) {
      if (!dateStr || dateStr.length !== 8) return ''
      return `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`
    },
    formatDateForPicker(dateStr) {
      if (!dateStr || dateStr.length !== 8) return null
      return new Date(+dateStr.slice(0,4), +dateStr.slice(4,6) - 1, +dateStr.slice(6,8))
    },
    handlePickerDateChange(val) {
      if (!val) return
      let d
      if (val instanceof Date) {
        d = val
      } else if (typeof val === 'string') {
        d = new Date(val)
      } else {
        // VueDatePicker may pass { year, month, day } object
        d = new Date(val.year, val.month, val.day || 1)
      }
      if (isNaN(d.getTime())) return
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      this.date = `${y}${m}${day}`
      this.handleOptionChange()
    },
    handleYearPickerChange(val) {
      if (!val) return
      const year = typeof val === 'object' ? val.year || val : val
      this.date = String(year)
      this.handleDateChange()
    },
    handleNativeDateChange(event) {
      const val = event.target.value
      if (val) {
        this.date = val.replace(/-/g, '')
        this.handleOptionChange()
      }
    },
    handleScroll() {
      const el = this.$refs.scrollbar
      if (el) this.showBackTop = el.scrollTop > 400
    },
    scrollToTop() {
      this.$refs.scrollbar?.scrollTo({ top: 0, behavior: 'smooth' })
    },
    handleDateChange() {
      this.seq = 1
      const options = this.seqOptions
      if (options.length) this.seq = options[0]
      return this.handleOptionChange()
    },
    handleOptionChange: async function () {
      let id = this.date
      if (this.isMagazine()) {
        let seqStr = "00" + this.seq
        seqStr = seqStr.substring(seqStr.length - 2)
        id = this.date + seqStr
      }
      await this.$router.replace({ name: this.name, params: { id } })
    },
    loadData: async function () {
      const docId = this.getCurrentDocId()
      const loadGeneration = this.loadGeneration + 1
      this.loadGeneration = loadGeneration
      this.currentDocId = docId
      this.loading = true

      try {
        await this.cleanupFullPdfDocument()
        this.prepareForDocumentLoad()
        this.downloadURL = this.getFullPdfDownloadURL()
        if (!this.isCurrentLoad(docId, loadGeneration)) return

        const fullPdfDocument = await this.ensureFullPdfDocument()
        if (!this.isCurrentLoad(docId, loadGeneration)) {
          await this.cleanupPdfDocument(fullPdfDocument)
          return
        }

        this.fullPdfDocument = markRaw(fullPdfDocument)
        this.fullPdfRenderSource = this.createPdfRenderSource(this.fullPdfDocument)
        this.maxPageCount = fullPdfDocument.numPages

        const hashPageNum = this.getHashPageNum()
        if (hashPageNum && hashPageNum > 1) {
          this.isViewportLazyLoadEnabled = false
          await this.handlePageChange(hashPageNum)
          return
        }

        this.addOneFullPdfPage(1, true)
        if (isThin() && this.maxPageCount > 1) this.addOneFullPdfPage(2, true)
      } catch (error) {
        if (!this.isCurrentLoad(docId, loadGeneration)) return
        console.error('PDF 文档加载失败:', error)
        this.downloadURL = ''
        this.isNoData = true
      } finally {
        this.loading = false
      }
    },
    getCurrentDocId() {
      return this.isMagazine() ? `${this.name}-${this.date}-${this.seq}` : `${this.name}-${this.date}`
    },
    getPdfPath() {
      let docId = this.date
      let year = this.date.substring(0, 4)
      if (this.isMagazine()) {
        let seqStr = "00" + this.seq
        seqStr = seqStr.substring(seqStr.length - 2)
        docId = this.date + seqStr
      }
      return `/${this.name.toUpperCase()}/${year}/${docId}.pdf`
    },
    getFullPdfURL() { return `${NEWSPAPER_HOST}${this.getPdfPath()}` },
    getFullPdfDownloadURL() { return this.getFullPdfURL() },
    prepareForDocumentLoad() {
      this.fullPdfDocument = null
      this.fullPdfRenderSource = null
      this.renderedPages = []
      this.pageLoadingPages = []
      this.failedPages = []
      this.isViewportLazyLoadEnabled = true
      this.isNoData = false
      this.goToPageAfterRendered = 0
      this.maxPageCount = 1
      this.jumpToPageNum = 1
    },
    isCurrentLoad(docId, loadGeneration) {
      return docId === this.currentDocId && loadGeneration === this.loadGeneration
    },
    createPdfRenderSource(fullPdfDocument) { return markRaw(fullPdfDocument) },
    async ensureFullPdfDocument() {
      const options = { url: this.getFullPdfURL(), cMapUrl: CMAP_URL, cMapPacked: true, wasmUrl: WASM_URL }
      const loadingTask = getDocument(options)
      this.fullPdfLoadingTask = loadingTask
      return loadingTask.promise
    },
    async cleanupFullPdfDocument() {
      const loadingTask = this.fullPdfLoadingTask
      const document = this.fullPdfDocument
      this.fullPdfLoadingTask = null
      this.fullPdfDocument = null
      this.fullPdfRenderSource = null
      await this.$nextTick()
      if (document) { await this.cleanupPdfDocument(document) }
      else { await this.destroyPdfLoadingTask(loadingTask) }
    },
    async destroyPdfLoadingTask(loadingTask) {
      if (loadingTask && loadingTask.destroy) {
        try { await loadingTask.destroy() } catch (e) {
          if (!String(e?.message || e).includes('Worker was destroyed')) console.warn('PDF 加载任务清理失败:', e)
        }
      }
    },
    async cleanupPdfDocument(document) {
      if (document && document.cleanup) {
        try { await document.cleanup() } catch (e) {
          if (!String(e?.message || e).includes('Worker was destroyed')) console.warn('PDF 文档清理失败:', e)
        }
      }
    },
    handlePageRendered(pageNum) {
      pageNum = Number(pageNum)
      this.removePageLoading(pageNum)
      this.loading = false
      this.updateCachedPageHeight()
      if (this.goToPageAfterRendered === pageNum) {
        const target = this.goToPageAfterRendered
        this.goToPageAfterRendered = 0
        this.$nextTick(() => {
          this.$nextTick(() => {
            document.querySelector(`#page-${target}`)?.scrollIntoView()
            this.isViewportLazyLoadEnabled = true
            this.$nextTick(() => { document.querySelector(`#page-${target}`)?.scrollIntoView() })
          })
        })
      }
    },
    handlePageRenderFailed(pageNum) {
      pageNum = Number(pageNum)
      this.removePageLoading(pageNum)
      this.removeRenderedPage(pageNum)
      this.addFailedPage(pageNum)
      this.loading = false
      if (this.goToPageAfterRendered === pageNum) {
        this.goToPageAfterRendered = 0
        this.isViewportLazyLoadEnabled = true
      }
    },
    updateCachedPageHeight() {
      for (let i = 1; i <= this.maxPageCount; i++) {
        if (this.isPageLoaded(i)) {
          const el = document.querySelector(`#page-${i}`)
          if (el && el.clientHeight > 0) { this.cachedPageHeight = el.clientHeight; break }
        }
      }
    },
    changeResolution() {
      if (!this.$refs.pdfRef) return
      this.loading = true
      const refs = Array.isArray(this.$refs.pdfRef) ? this.$refs.pdfRef : [this.$refs.pdfRef]
      refs.forEach(r => r.renderPage())
    },
    addOneFullPdfPage(page, isInitial = false) {
      const pageNum = Number(page)
      if (!this.fullPdfDocument || !pageNum || pageNum < 1 || pageNum > this.maxPageCount) {
        if (!isInitial) this.loading = false
        return
      }
      if (this.isPageLoaded(pageNum)) { if (!isInitial) this.loading = false; return }
      this.removeFailedPage(pageNum)
      this.renderedPages.push(pageNum)
      this.renderedPages.sort((a, b) => a - b)
      this.addPageLoading(pageNum)
    },
    addPageLoading(pageNum) { if (!this.pageLoadingPages.includes(Number(pageNum))) this.pageLoadingPages.push(Number(pageNum)) },
    removePageLoading(pageNum) { this.pageLoadingPages = this.pageLoadingPages.filter(p => p !== Number(pageNum)) },
    addFailedPage(pageNum) { pageNum = Number(pageNum); if (!this.failedPages.includes(pageNum)) { this.failedPages.push(pageNum); this.failedPages.sort((a,b) => a-b) } },
    removeFailedPage(pageNum) { this.failedPages = this.failedPages.filter(p => p !== Number(pageNum)) },
    removeRenderedPage(pageNum) { this.renderedPages = this.renderedPages.filter(p => p !== Number(pageNum)) },
    isPageLoading(pageNum) { return this.pageLoadingPages.includes(Number(pageNum)) },
    isPageFailed(pageNum) { return this.failedPages.includes(Number(pageNum)) },
    handlePageEnter(el) { if (el instanceof Event) el = el.currentTarget; this.addOneFullPdfPage(el.dataset.pageNum, true) },
    handleManualPageLoad(pageNum) { this.loading = true; this.addOneFullPdfPage(pageNum) },
    handleRetryPage(pageNum) { this.loading = true; this.removeFailedPage(pageNum); this.addOneFullPdfPage(pageNum) },
    async handlePageChange(curr) {
      curr = Number(curr)
      if (!curr) return
      curr = Math.max(1, Math.min(curr, this.maxPageCount))
      this.jumpToPageNum = curr
      if (!this.fullPdfDocument) return
      if (!this.isPageLoaded(curr)) {
        this.goToPageAfterRendered = curr
        this.loading = true
        this.addOneFullPdfPage(curr)
      } else {
        await this.goToPage(curr)
      }
      if (curr) window.location.hash = `#page-${curr}`
    },
    async goToPage(pageNum) {
      if (!this.isPageLoaded(pageNum)) { this.goToPageAfterRendered = pageNum; this.addOneFullPdfPage(pageNum); return }
      this.$nextTick(() => { document.querySelector(`#page-${pageNum}`)?.scrollIntoView() })
    },
    isPageLoaded(pageNum) { return this.renderedPages.includes(Number(pageNum)) },
    getHashPageNum() {
      const m = /^#page-(\d+)$/i.exec(window.location.hash)
      return m ? parseInt(m[1]) : 0
    },
    isMagazine() { return this.type === "magazine" },
    handleWindowResize() {
      if (this.resizeTimer) clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => { /* no-op: native scroll handles resize */ }, 100)
    },
    _startObserving() {
      this.$nextTick(() => {
        if (!this._lazyObserver) return
        document.querySelectorAll('[id^="page-empty-"]').forEach(el => this._lazyObserver.observe(el))
      })
    }
  },
  beforeRouteLeave(to, from, next) { this.loading = false; next() },
}
</script>

<style>
#viewer .pdf-page-rendering canvas { width: 100% !important; height: auto !important; }
</style>
