<script setup lang="ts">
const model = defineModel<string>({ required: true })

defineProps<{
  disabled: boolean
}>()

const emit = defineEmits<{
  send: []
}>()

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    emit('send')
  }
}
</script>

<template>
  <footer class="composer">
    <div class="composer-card">
      <textarea
        v-model="model"
        rows="3"
        placeholder="输入问题，Enter 发送，Shift + Enter 换行"
        @keydown="handleKeydown"
      ></textarea>
      <button
        class="send-btn"
        type="button"
        :disabled="disabled"
        @click="emit('send')"
      >
        发送
      </button>
    </div>
  </footer>
</template>

<style scoped>
.composer {
  padding: 0 30px 28px;
}

.composer-card {
  display: flex;
  gap: 18px;
  align-items: stretch;
  padding: 28px 30px;
  border-radius: 0;
  background: rgba(255, 252, 245, 0.74);
  border: 4px solid var(--primary-color);
  box-shadow:
    inset 0 0 0 9px rgb(245, 239, 230),
    inset 0 0 0 10.5px var(--primary-color);
}

.composer-card textarea {
  flex: 1;
  min-height: 120px;
  padding: 22px 24px;
  border: 1px solid rgba(157, 22, 28, 0.56);
  border-radius: 0;
  resize: none;
  outline: none;
  font: inherit;
  background: rgba(255, 251, 245, 0.92);
}

.send-btn {
  min-width: 72px;
  min-height: 44px;
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0;
  padding: 12px 18px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
}

.send-btn:disabled {
  cursor: not-allowed;
  opacity: 1;
  background: transparent !important;
  color: rgba(157, 22, 28, 0.58) !important;
  border-color: rgba(157, 22, 28, 0.42) !important;
  box-shadow: none;
}

@media (max-width: 1024px) {
  .composer {
    padding-left: 18px;
    padding-right: 18px;
  }
}

@media (max-width: 640px) {
  .composer-card {
    flex-direction: column;
    align-items: stretch;
  }

  .send-btn {
    width: 100%;
  }
}
</style>
