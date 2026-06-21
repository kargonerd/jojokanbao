<script setup lang="ts">
import NavBar from '@/components/NavBar.vue'
import MemorialDialog from '@/components/MemorialDialog.vue'
import { ref, onMounted } from 'vue'

const memorialDialog = ref<InstanceType<typeof MemorialDialog>>()

onMounted(() => {
  const today = new Date()
  const year = today.getFullYear()
  if (today.getMonth() === 11 && today.getDate() === 26) {
    if (!localStorage.getItem(`mao-memorial-${year}`)) {
      setTimeout(() => memorialDialog.value?.showDialog(), 1000)
    }
  }
})
</script>

<template>
  <div class="h-full flex flex-col">
    <header class="h-[58px] shrink-0 border-b border-rule-dark z-20">
      <NavBar />
    </header>
    <main class="flex-1 overflow-hidden">
      <router-view />
    </main>
    <MemorialDialog ref="memorialDialog" />
  </div>
</template>

<style>
html, body, #app { height: 100%; }
</style>
