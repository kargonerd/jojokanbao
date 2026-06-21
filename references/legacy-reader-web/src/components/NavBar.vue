<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const mobileOpen = ref(false)

const navItems = [
  { name: 'home', label: '首页', to: '/' },
  { name: 'newspapers', label: '报纸', children: [
    { name: 'rmrb', label: '人民日报', to: '/rmrb/19761009' },
    { name: 'ckxx', label: '参考消息', to: '/ckxx/19760910' },
  ]},
  { name: 'magazines', label: '杂志', children: [
    { name: 'hq', label: '红旗', to: '/hq/196419' },
    { name: 'rmhb', label: '人民画报', to: '/rmhb/197292' },
    { name: 'sjzs', label: '世界知识', to: '/sjzs/196513' },
  ]},
  { name: 'search', label: '搜索', to: '/search' },
  { name: 'support', label: '反馈', to: '/support' },
]

const openDropdown = ref<string | null>(null)

function isActive(item: any): boolean {
  if (item.to) return route.name === item.name
  if (item.children) return item.children.some((c: any) => route.name === c.name)
  return false
}

function toggleDropdown(name: string) {
  openDropdown.value = openDropdown.value === name ? null : name
}

function closeDropdown() {
  openDropdown.value = null
}
</script>

<template>
  <nav class="h-full flex items-center px-6 bg-paper font-serif relative" @mouseleave="closeDropdown">
    <!-- Desktop nav -->
    <ul class="hidden md:flex items-center h-full gap-0 list-none m-0 p-0">
      <li v-for="item in navItems" :key="item.name" class="relative h-full flex items-center">
        <!-- Simple link -->
        <router-link
          v-if="item.to"
          :to="item.to"
          class="relative h-full flex items-center px-5 text-sm font-bold tracking-wide text-ink no-underline transition-colors hover:text-red"
          :class="{ 'text-red': isActive(item) }"
        >
          {{ item.label }}
          <span v-if="isActive(item)" class="absolute bottom-2.5 left-5 right-5 h-0.5 bg-red animate-[scaleX_.25s_ease-out]"></span>
        </router-link>

        <!-- Dropdown trigger -->
        <button
          v-else
          class="relative h-full flex items-center px-5 text-sm font-bold tracking-wide text-ink border-0 bg-transparent transition-colors hover:text-red"
          :class="{ 'text-red': isActive(item) }"
          @mouseenter="openDropdown = item.name"
          @click="toggleDropdown(item.name)"
        >
          {{ item.label }}
          <svg class="ml-1 w-3 h-3 opacity-50" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5l3 3 3-3"/></svg>
          <span v-if="isActive(item)" class="absolute bottom-2.5 left-5 right-5 h-0.5 bg-red"></span>
        </button>

        <!-- Dropdown menu -->
        <ul
          v-if="item.children && openDropdown === item.name"
          class="absolute top-full left-0 min-w-[168px] m-0 p-0 list-none bg-paper border-2 border-red shadow-[4px_4px_0_rgba(139,26,26,.14)] z-50 animate-[dropIn_.15s_ease-out]"
          @mouseleave="closeDropdown"
        >
          <li v-for="(child, i) in item.children" :key="child.name" :class="{ 'border-t border-red/20': i > 0 }">
            <router-link
              :to="child.to"
              class="block px-5 py-3 text-sm font-bold text-red no-underline transition-all duration-[180ms] hover:bg-red hover:text-cream"
              @click="closeDropdown"
            >
              {{ child.label }}
            </router-link>
          </li>
        </ul>
      </li>
    </ul>

    <!-- Quote (desktop) -->
    <p class="hidden lg:block ml-auto text-[13px] italic font-bold text-red opacity-80 tracking-wider truncate max-w-[44vw] m-0">
      如果要看前途，一定要看历史 &nbsp;——毛泽东
    </p>

    <!-- Mobile hamburger -->
    <button
      class="md:hidden ml-auto p-2 border-0 bg-transparent text-ink"
      @click="mobileOpen = !mobileOpen"
      aria-label="菜单"
    >
      <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
        <path v-if="!mobileOpen" fill-rule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z"/>
        <path v-else fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"/>
      </svg>
    </button>

    <!-- Mobile menu -->
    <div v-if="mobileOpen" class="absolute top-full left-0 right-0 bg-paper border-b border-rule-dark z-50 md:hidden">
      <ul class="list-none m-0 p-4 space-y-1">
        <template v-for="item in navItems" :key="item.name">
          <li v-if="item.to">
            <router-link
              :to="item.to"
              class="block py-2 px-3 text-sm font-bold text-ink no-underline hover:text-red"
              :class="{ 'text-red': isActive(item) }"
              @click="mobileOpen = false"
            >
              {{ item.label }}
            </router-link>
          </li>
          <template v-else>
            <li class="pt-3 pb-1 px-3 text-xs font-bold text-muted tracking-widest uppercase">{{ item.label }}</li>
            <li v-for="child in item.children" :key="child.name">
              <router-link
                :to="child.to"
                class="block py-2 px-6 text-sm font-bold text-ink no-underline hover:text-red"
                :class="{ 'text-red': isActive(child) }"
                @click="mobileOpen = false"
              >
                {{ child.label }}
              </router-link>
            </li>
          </template>
        </template>
      </ul>
    </div>
  </nav>
</template>
