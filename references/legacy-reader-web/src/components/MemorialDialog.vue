<script setup lang="ts">
import { ref } from 'vue'

const dialogVisible = ref(false)

function showDialog() { dialogVisible.value = true }
function handleCancel() { dialogVisible.value = false; record() }
function handleGoToMemorial() { dialogVisible.value = false; record(); window.open('https://redstar.jojokanbao.cn', '_blank') }
function record() { localStorage.setItem(`mao-memorial-${new Date().getFullYear()}`, 'true') }

defineExpose({ showDialog })
</script>

<template>
  <Transition name="memorial-fade">
    <div v-if="dialogVisible" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/36">
      <div class="w-[400px] max-w-[90%] border-4 border-red bg-paper shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)] animate-[slideUp_.24s_ease-out]">
        <div class="px-5 py-4 text-center border-b border-rule-dark">
          <h2 class="text-[22px] font-bold tracking-wider text-ink m-0">毛主席诞辰纪念日</h2>
        </div>
        <div class="py-8 px-5 text-center">
          <svg class="w-12 h-12 mx-auto mb-4 text-red" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.39 4.84 5.34.78-3.87 3.77.91 5.32L10 13.27l-4.77 2.51.91-5.32L2.27 6.69l5.34-.78L10 1z"/></svg>
          <p class="text-lg font-bold text-ink mb-3">今天是毛主席诞辰132周年</p>
          <p class="text-base text-muted">是否前往纪念缅怀</p>
        </div>
        <div class="flex justify-center gap-4 px-5 pb-6">
          <button class="btn btn-outline" @click="handleCancel">取消</button>
          <button class="btn" @click="handleGoToMemorial">前往纪念 →</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.memorial-fade-enter-active, .memorial-fade-leave-active { transition: opacity .24s; }
.memorial-fade-enter-from, .memorial-fade-leave-to { opacity: 0; }
@keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
</style>
