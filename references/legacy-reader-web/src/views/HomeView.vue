<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

const cards = [
  { id: 1, title: '人民日报', image: new URL('../assets/rmrb.jpeg', import.meta.url).href, route: '/rmrb/19761009', publisher: '中国共产党中央委员会', year: '1946 —' },
  { id: 2, title: '参考消息', image: new URL('../assets/cankaoxiaoxi.jpeg', import.meta.url).href, route: '/ckxx/19760910', publisher: '新华通讯社', year: '1957 —' },
  { id: 3, title: '红旗', image: new URL('../assets/hq.jpg', import.meta.url).href, route: '/hq/196419', publisher: '中国共产党中央委员会', year: '1958 — 1988' },
  { id: 4, title: '人民画报', image: new URL('../assets/rmhb.jpg', import.meta.url).href, route: '/rmhb/197292', publisher: '人民画报社', year: '1950 —' },
  { id: 5, title: '世界知识', image: new URL('../assets/sjzs.jpg', import.meta.url).href, route: '/sjzs/196513', publisher: '世界知识出版社', year: '1934 —' },
]
</script>

<template>
  <div class="h-full overflow-y-auto bg-paper">
    <div class="max-w-5xl mx-auto px-6 py-12 md:py-20">
      <!-- Grid: equal cards, landscape images -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        <article
          v-for="card in cards"
          :key="card.id"
          class="group cursor-pointer border-2 border-red transition-all duration-[180ms] ease hover:-translate-y-0.5 hover:shadow-[4px_4px_0_rgba(139,26,26,.14)]"
          @click="router.push(card.route)"
        >
          <!-- Image: natural size -->
          <div class="overflow-hidden">
            <img
              :src="card.image"
              :alt="card.title"
              class="w-full block transition-transform duration-500 ease-out group-hover:scale-[1.03]"
            />
          </div>
          <!-- Info -->
          <div class="px-4 py-3.5 border-t border-red/30 bg-paper">
            <h2 class="text-lg font-bold text-red tracking-wider m-0">{{ card.title }}</h2>
            <div class="flex items-center justify-between mt-1.5">
              <span class="text-xs text-muted">{{ card.publisher }}</span>
              <span class="text-xs text-muted tracking-wider">{{ card.year }}</span>
            </div>
          </div>
        </article>
      </div>

      <!-- Footer -->
      <p class="text-center text-xs text-muted mt-12 tracking-wider">JOJO看报 · 原版影印 · 历史文献数字档案</p>
    </div>
  </div>
</template>
