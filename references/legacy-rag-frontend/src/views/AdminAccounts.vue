<template>
  <div class="admin-page">
    <div class="page-header">
      <div>
        <h2>NotebookLM 账号管理</h2>
        <p>这里只管理账号本身，以及该账号下同步出来的 notebooks。</p>
      </div>
      <button class="ui-btn ui-btn-primary" @click="showAddAccount = true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
        添加账号
      </button>
    </div>

    <div class="card ui-card">
      <div class="card-title">已添加账号</div>

      <div v-if="accounts.length === 0" class="empty-state">
        暂无账号，请先添加一个 NotebookLM 账号。
      </div>

      <div v-else class="account-list">
        <div v-for="account in accounts" :key="account.id" class="account-item-wrapper">
          <div class="account-item" @click="toggleAccordion(account.id)">
            <div class="account-info">
              <div class="name">
                <svg
                  :style="{ transform: expandedAccounts.includes(account.id) ? 'rotate(90deg)' : '' }"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
                {{ account.name }}
              </div>
              <div class="meta">
                {{ account.notebooks?.length || 0 }} 个 notebooks
                <span v-if="account.expires_at">· {{ account.expires_at }}</span>
              </div>
            </div>
            <div class="account-actions">
              <button
                class="ui-btn ui-btn-secondary ui-btn-small"
                @click.stop="refreshAccount(account.id)"
                :disabled="busyAccountId === account.id"
              >
                {{ busyAccountId === account.id ? '刷新中...' : '刷新' }}
              </button>
              <button class="ui-btn ui-btn-danger ui-btn-small" @click.stop="confirmDeleteAccount(account.id)">
                删除
              </button>
            </div>
          </div>

          <div v-if="expandedAccounts.includes(account.id)" class="account-notebooks">
            <div v-if="account.notebooks?.length" class="notebook-list">
              <div v-for="nb in account.notebooks" :key="nb.id" class="notebook-item">
                <div class="title">{{ nb.title }}</div>
              </div>
            </div>
            <div v-else class="empty-inline">该账号下暂时还没有 notebook。</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showAddAccount" class="modal-overlay" @click.self="showAddAccount = false">
      <div class="modal">
        <div class="modal-header">
          <h3>添加 NotebookLM 账号</h3>
          <button class="close-btn" @click="showAddAccount = false">×</button>
        </div>
        <div class="modal-body">
          <div class="cookie-help">
            <details>
              <summary>如何获取 NotebookLM Cookie？</summary>
              <ol>
                <li>打开 NotebookLM 并登录账号</li>
                <li>按 F12 打开开发者工具，切到 Network</li>
                <li>刷新页面，任选一个请求复制 Cookie</li>
                <li>也可以用浏览器扩展导出 Cookie</li>
              </ol>
            </details>
          </div>

          <div class="form-group ui-form-group">
            <label>备注</label>
            <input v-model="newAccountName" type="text" placeholder="例如：主账号">
          </div>
          <div class="form-group ui-form-group">
            <label>NotebookLM Cookie</label>
            <textarea
              v-model="newAccountCookie"
              rows="8"
              placeholder='支持 JSON 数组或 "name=value; name2=value2" 形式'
            ></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ui-btn ui-btn-secondary" @click="showAddAccount = false">取消</button>
          <button class="ui-btn ui-btn-primary" @click="addAccount" :disabled="creating">
            {{ creating ? '添加中...' : '添加账号' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showDeleteConfirm" class="modal-overlay" @click.self="showDeleteConfirm = false">
      <div class="modal modal-small">
        <div class="modal-header">
          <h3>确认删除</h3>
          <button class="close-btn" @click="showDeleteConfirm = false">×</button>
        </div>
        <div class="modal-body">
          删除账号后，该账号同步到的 notebook 关联关系也会被移除。
        </div>
        <div class="modal-footer">
          <button class="ui-btn ui-btn-secondary" @click="showDeleteConfirm = false">取消</button>
          <button class="ui-btn ui-btn-danger" @click="executeDelete">删除</button>
        </div>
      </div>
    </div>

    <div v-if="toast" class="toast ui-toast" :class="toast.type">{{ toast.message }}</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminCatalogApi } from '../api'
import { useToast } from '../composables/useToast'
import type { AdminAccount } from '../types'

const accounts = ref<AdminAccount[]>([])
const expandedAccounts = ref<number[]>([])
const busyAccountId = ref<number | null>(null)
const creating = ref(false)
const showAddAccount = ref(false)
const showDeleteConfirm = ref(false)
const deleteTargetId = ref<number | null>(null)
const newAccountName = ref('')
const newAccountCookie = ref('')
const { toast, showToast } = useToast()

function toggleAccordion(id: number) {
  const index = expandedAccounts.value.indexOf(id)
  if (index === -1) {
    expandedAccounts.value.push(id)
  } else {
    expandedAccounts.value.splice(index, 1)
  }
}

async function loadAccounts() {
  try {
    accounts.value = await adminCatalogApi.getAccounts()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '加载账号失败', 'error')
  }
}

async function addAccount() {
  if (!newAccountName.value.trim() || !newAccountCookie.value.trim()) {
    showToast('请填写账号备注和 Cookie', 'error')
    return
  }

  creating.value = true
  try {
    accounts.value = await adminCatalogApi.addAccount({
      name: newAccountName.value.trim(),
      cookie: newAccountCookie.value.trim(),
    })
    newAccountName.value = ''
    newAccountCookie.value = ''
    showAddAccount.value = false
    showToast('账号已添加')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '添加失败', 'error')
  } finally {
    creating.value = false
  }
}

function confirmDeleteAccount(id: number) {
  deleteTargetId.value = id
  showDeleteConfirm.value = true
}

async function executeDelete() {
  if (deleteTargetId.value === null) {
    return
  }

  try {
    accounts.value = await adminCatalogApi.deleteAccount(deleteTargetId.value)
    expandedAccounts.value = expandedAccounts.value.filter(id => id !== deleteTargetId.value)
    showToast('账号已删除')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '删除失败', 'error')
  } finally {
    showDeleteConfirm.value = false
    deleteTargetId.value = null
  }
}

async function refreshAccount(id: number) {
  busyAccountId.value = id
  try {
    accounts.value = await adminCatalogApi.refreshAccount(id)
    showToast('账号信息已刷新')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '刷新失败', 'error')
  } finally {
    busyAccountId.value = null
  }
}

onMounted(loadAccounts)
</script>

<style scoped>
.admin-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.page-header h2 {
  font-size: 30px;
  letter-spacing: 0.02em;
}

.page-header p {
  margin-top: 8px;
  color: var(--text-secondary);
}

.card {
  padding: 18px 20px;
  border-radius: 0;
  background: rgba(255, 251, 245, 0.7);
  border: 1px solid rgba(157, 22, 28, 0.2);
  box-shadow: none;
}

.card-title {
  margin-bottom: 12px;
  font-size: 17px;
  font-weight: 700;
}

.account-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.account-item-wrapper {
  border-top: 1px solid rgba(157, 22, 28, 0.16);
  background: transparent;
}

.account-item-wrapper:first-child {
  border-top: none;
}

.account-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 14px 0;
  cursor: pointer;
}

.account-info {
  min-width: 0;
}

.name {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 17px;
  font-weight: 700;
}

.meta {
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: 13px;
}

.account-actions,
.modal-footer,
.page-header .btn {
  display: flex;
  gap: 8px;
}

.account-notebooks {
  padding: 0 0 18px;
}

.notebook-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}

.notebook-item {
  padding: 12px 14px;
  border-radius: 0;
  background: rgba(255, 251, 245, 0.72);
  border-left: 3px solid rgba(157, 22, 28, 0.42);
}

.title {
  font-weight: 700;
}

.empty-state,
.empty-inline {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
}

.ui-btn-small {
  min-width: 0;
  padding: 7px 10px;
  font-size: 13px;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 10, 10, 0.38);
}

.modal {
  width: min(680px, 100%);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  overflow: hidden;
}

.modal-small {
  width: min(420px, 100%);
}

.modal-header,
.modal-footer {
  padding: 18px 20px;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
}

.modal-body {
  padding: 20px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}

.cookie-help {
  padding: 14px 16px;
  background: rgba(157, 22, 28, 0.04);
  border: 1px solid rgba(157, 22, 28, 0.12);
}

.cookie-help ol {
  margin-top: 10px;
  padding-left: 18px;
  color: var(--text-secondary);
}

.close-btn {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 28px;
  cursor: pointer;
}

@media (max-width: 720px) {
  .page-header,
  .account-item {
    flex-direction: column;
    align-items: stretch;
  }

  .account-actions,
  .page-header .btn {
    width: 100%;
  }

  .account-actions .btn,
  .page-header .btn {
    flex: 1;
  }
}
</style>
