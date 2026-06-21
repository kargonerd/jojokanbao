<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import axios from 'axios'
import dayjs from 'dayjs'
import { VueDatePicker } from '@vuepic/vue-datepicker'
import { SEARCH_API } from '@/constants'

const route = useRoute()
const router = useRouter()

const searchInput = ref<HTMLInputElement>()
const scrollContainer = ref<HTMLElement>()
const searchTerm = ref('')
const searchResults = ref<any[] | null>(null)
const currentPage = ref(1)
const pageSize = 10
const total = ref(0)
const beforeSearch = ref(true)
const sortOrder = ref('')
const startDate = ref('')
const endDate = ref('')
const startDateObj = ref<Date | null>(null)
const endDateObj = ref<Date | null>(null)
const loading = ref(false)
let scrollAnimationId: number | null = null

const totalPages = () => Math.ceil(total.value / pageSize)

onMounted(() => {
  const q = route.query
  if (q.keyword) {
    searchTerm.value = q.keyword as string
    beforeSearch.value = false
    if (q.page) currentPage.value = parseInt(q.page as string)
    if (q.sort) sortOrder.value = q.sort as string
    if (q.startDate) { startDate.value = q.startDate as string; startDateObj.value = new Date(q.startDate as string) }
    if (q.endDate) { endDate.value = q.endDate as string; endDateObj.value = new Date(q.endDate as string) }
    fetchResults()
  } else {
    nextTick(() => searchInput.value?.focus())
  }
})

onBeforeUnmount(() => {
  if (scrollAnimationId) {
    cancelAnimationFrame(scrollAnimationId)
    scrollAnimationId = null
  }
})

function handleDateFilter() {
  if (startDateObj.value) {
    startDate.value = dayjs(startDateObj.value).format('YYYY-MM-DD')
  }
  if (endDateObj.value) {
    endDate.value = dayjs(endDateObj.value).format('YYYY-MM-DD')
  }
  if (startDate.value && endDate.value) handleSearch()
}

async function handleSearch() {
  if (!searchTerm.value.trim()) return
  currentPage.value = 1
  updateURL()
  await fetchResults()
}

function handlePageChange(page: number) {
  currentPage.value = page
  updateURL()
  fetchResults()
  scrollToTop()
}

function updateURL() {
  const query: Record<string, any> = { keyword: searchTerm.value }
  if (currentPage.value > 1) query.page = currentPage.value
  if (sortOrder.value) query.sort = sortOrder.value
  if (startDate.value) query.startDate = startDate.value
  if (endDate.value) query.endDate = endDate.value
  router.replace({ query })
}

async function fetchResults() {
  loading.value = true
  try {
    const params: Record<string, any> = {
      keyword: searchTerm.value,
      page: currentPage.value,
      size: pageSize,
    }
    if (sortOrder.value) params.sort = sortOrder.value
    if (startDate.value && endDate.value) {
      params.startDate = startDate.value
      params.endDate = endDate.value
    }
    const response = await axios.get(SEARCH_API, { params })
    const results = response.data.data.results
    searchResults.value = results.map(processHighlight)
    total.value = response.data.data.total
    beforeSearch.value = false
  } catch (e) {
    if (!axios.isCancel(e)) searchResults.value = null
  } finally {
    loading.value = false
  }
}

function processHighlight(s: any) {
  s.title = highlight(s.title, false, true)
  s.content = highlight(s.content, true, false)
  s.ellipsis = true
  return s
}

function highlight(str: string, replaceBreaks: boolean, strong: boolean) {
  let out = replaceBreaks ? str.replace(/\n/g, '<br>') : str
  const tag = strong ? 'strong' : 'span'
  out = out.replace(/@highlight@/g, `<${tag} class="text-red">`)
  out = out.replace(/@\/highlight@/g, `</${tag}>`)
  return out
}

function generatePDFLink(date: string, page: number) {
  return `/rmrb/${date.replace(/-/g, '')}#page-${page}`
}

function generatePageStr(page: number) {
  return page ? `第${page}版` : ''
}

function scrollToTop() {
  const el = scrollContainer.value
  if (!el) return
  el.scrollTo({ top: 0, behavior: 'smooth' })
}
</script>

<template>
  <div ref="scrollContainer" class="h-full overflow-y-auto bg-paper text-ink">
    <!-- Loading overlay -->
    <div v-if="loading" class="fixed inset-0 z-50 flex items-center justify-center bg-paper/90">
      <div class="text-center">
        <div class="w-6 h-6 border-2 border-red border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
        <p class="text-sm font-bold text-red tracking-wide">文档加载中，请耐心等待</p>
      </div>
    </div>

    <!-- Centered search (before first search) -->
    <div v-if="beforeSearch" class="fixed inset-0 flex items-center justify-center z-10">
      <div class="w-[90%] max-w-[600px] p-6 border-4 border-red shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)]">
        <div class="flex gap-3">
          <input
            ref="searchInput"
            v-model="searchTerm"
            placeholder="在JOJO看报上搜索"
            class="flex-1 h-10 text-sm"
            @keyup.enter="handleSearch"
          />
          <button class="btn" @click="handleSearch">搜索</button>
        </div>
      </div>
    </div>

    <!-- Results view -->
    <div v-if="!beforeSearch" class="max-w-[960px] mx-auto px-6 pb-12">
      <!-- Top search bar -->
      <div class="flex gap-3 py-5">
        <input
          ref="searchInput"
          v-model="searchTerm"
          placeholder="在JOJO看报上搜索"
          class="flex-1 h-10 text-sm"
          @keyup.enter="handleSearch"
        />
        <button class="btn" @click="handleSearch">搜索</button>
      </div>

      <!-- Toolbar: filters -->
      <div class="flex flex-wrap items-center gap-4 p-3.5 border border-rule mb-6">
        <label class="flex items-center gap-2 text-xs font-bold text-muted">
          从
          <VueDatePicker
            v-model="startDateObj"
            :enable-time-picker="false"
            :clearable="false"
            auto-apply
            locale="zh-CN"
            format="yyyy年MM月dd日"
            style="width: 155px"
            @update:model-value="handleDateFilter"
          />
        </label>
        <label class="flex items-center gap-2 text-xs font-bold text-muted">
          至
          <VueDatePicker
            v-model="endDateObj"
            :enable-time-picker="false"
            :clearable="false"
            auto-apply
            locale="zh-CN"
            format="yyyy年MM月dd日"
            style="width: 155px"
            @update:model-value="handleDateFilter"
          />
        </label>
        <select v-model="sortOrder" class="h-8 text-xs px-2 min-w-[100px]" @change="handleSearch">
          <option value="">默认排序</option>
          <option value="match">最佳匹配</option>
          <option value="timeAsc">时间升序</option>
          <option value="timeDesc">时间降序</option>
        </select>
      </div>

      <!-- Results -->
      <div v-if="searchResults">
        <!-- Empty state -->
        <div v-if="searchResults.length === 0" class="py-20 text-center">
          <p class="text-muted font-bold">没有找到相关结果</p>
        </div>

        <!-- Result list -->
        <ol v-else class="list-none m-0 p-0 counter-reset-[result]">
          <li
            v-for="(result, i) in searchResults"
            :key="i"
            class="relative pl-14 py-5 border-t border-rule first:border-rule-dark counter-increment-[result]"
          >
            <!-- Number decoration -->
            <span class="absolute left-0 top-5 w-9 pb-1.5 border-b-2 border-red text-red text-[13px] font-bold tracking-wider">
              {{ String(i + 1 + (currentPage - 1) * pageSize).padStart(2, '0') }}
            </span>

            <a :href="generatePDFLink(result.date, result.page)" target="_blank" class="block">
              <h3 class="text-xl font-bold text-ink tracking-wide m-0 hover:text-red transition-colors" v-html="result.title"></h3>
            </a>

            <div class="flex gap-1.5 py-2">
              <span class="tag">人民日报</span>
              <span class="tag">{{ result.date }}</span>
              <span v-if="result.page" class="tag">{{ generatePageStr(result.page) }}</span>
            </div>

            <div
              class="text-sm leading-7 text-ink/80"
              :class="{ 'line-clamp-3': result.ellipsis }"
              v-html="result.content"
            ></div>
            <button
              v-if="result.ellipsis"
              class="mt-1 text-xs font-bold text-red border-0 bg-transparent p-0 hover:text-red-dark"
              @click="result.ellipsis = false"
            >
              显示全部
            </button>
          </li>
        </ol>

        <!-- Pagination -->
        <nav v-if="totalPages() > 1" class="flex items-center justify-center gap-1 mt-8">
          <button
            class="w-8 h-8 text-sm font-bold border border-transparent bg-paper text-ink disabled:opacity-30"
            :disabled="currentPage <= 1"
            @click="handlePageChange(currentPage - 1)"
          >‹</button>
          <template v-for="p in totalPages()" :key="p">
            <button
              v-if="p === 1 || p === totalPages() || (p >= currentPage - 2 && p <= currentPage + 2)"
              class="w-8 h-8 text-sm font-bold border bg-paper"
              :class="p === currentPage ? 'border-red text-red' : 'border-transparent text-ink hover:text-red'"
              @click="handlePageChange(p)"
            >{{ p }}</button>
            <span v-else-if="p === currentPage - 3 || p === currentPage + 3" class="px-1 text-muted">…</span>
          </template>
          <button
            class="w-8 h-8 text-sm font-bold border border-transparent bg-paper text-ink disabled:opacity-30"
            :disabled="currentPage >= totalPages()"
            @click="handlePageChange(currentPage + 1)"
          >›</button>
        </nav>
      </div>
    </div>
  </div>
</template>

<style scoped>
.counter-reset-\[result\] { counter-reset: result; }
.counter-increment-\[result\] { counter-increment: result; }
</style>
