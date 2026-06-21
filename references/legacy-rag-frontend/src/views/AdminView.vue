<template>
  <div class="admin-layout">
    <div v-if="isCheckingAuth" class="admin-loading" aria-hidden="true"></div>
    <div v-else-if="!isLoggedIn" class="login-container">
      <div class="login-box">
        <div class="login-icon">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
          </svg>
        </div>
        <h2>管理后台</h2>
        <p class="login-subtitle">请输入管理员密码</p>

        <div v-if="loginError" class="alert alert-error">{{ loginError }}</div>

        <div class="input-group">
          <input
            v-model="password"
            type="password"
            placeholder="管理员密码"
            @keydown.enter="handleLogin"
          >
        </div>

        <button class="btn btn-primary login-btn" @click="handleLogin">登录</button>
      </div>
    </div>

    <div v-else class="app-container">
      <aside class="sidebar">
        <div class="sidebar-header">
          <h1 class="logo">
            <span class="brand-mark">JOJO读书</span>
            <span class="brand-sub">管理后台</span>
          </h1>
        </div>

        <div class="sidebar-section">
          <div class="section-header">管理菜单</div>
          <div class="nav-menu">
            <router-link to="/admin/accounts" class="nav-item" :class="{ active: $route.path === '/admin/accounts' }">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
              </svg>
              <span>账号管理</span>
            </router-link>
            <router-link to="/admin/libraries" class="nav-item" :class="{ active: $route.path === '/admin/libraries' }">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
              </svg>
              <span>文库管理</span>
            </router-link>
          </div>
        </div>

        <div class="sidebar-footer">
          <button class="logout-btn" @click="handleLogout">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
            </svg>
            退出登录
          </button>
        </div>
      </aside>

      <main class="main-content">
        <router-view />
      </main>
    </div>

    <div v-if="toast" class="toast" :class="toast.type">{{ toast.message }}</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { initializeAdminAuth, isCheckingAuth, isLoggedIn, login, loginError, logout, password } from '../composables/useAdminAuth'
import { useToast } from '../composables/useToast'

const router = useRouter()
const { toast, showToast } = useToast()

async function handleLogin() {
  const ok = await login()
  if (!ok) return
  showToast('登录成功')
  router.push('/admin/accounts')
}

function handleLogout() {
  logout()
  router.push('/admin')
}

onMounted(initializeAdminAuth)
</script>

<style scoped>
.admin-layout {
  position: relative;
  min-height: 100vh;
  background:
    radial-gradient(circle at top left, rgba(158, 19, 27, 0.06), transparent 20%),
    linear-gradient(180deg, #faf7f2 0%, #f4ece1 100%);
}

.admin-layout::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(255, 251, 245, 0.84), rgba(255, 251, 245, 0.84)),
    radial-gradient(circle at center top, rgba(157, 22, 28, 0.05), transparent 26%);
  pointer-events: none;
}

.admin-loading {
  min-height: 100dvh;
}

.login-container {
  position: relative;
  z-index: 1;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.login-box {
  width: min(560px, calc(100vw - 48px));
  padding: 42px 46px 40px;
  border-radius: 0;
  background: rgba(255, 251, 245, 0.94);
  box-shadow: none;
  border: 4px solid var(--primary-color);
  display: grid;
  justify-items: center;
  text-align: center;
  gap: 0;
}

.login-icon {
  margin-bottom: 18px;
  color: var(--primary-color);
  display: flex;
  justify-content: center;
}

.login-box h2 {
  font-size: 46px;
  line-height: 1.06;
  letter-spacing: 0.04em;
  text-align: center;
}

.login-subtitle {
  margin-top: 10px;
  color: var(--text-secondary);
  font-size: 16px;
  text-align: center;
}

.alert {
  width: 100%;
  margin-top: 22px;
  padding: 12px 14px;
  border-radius: 0;
  font-size: 14px;
  border: 1px solid rgba(180, 35, 24, 0.42);
  text-align: center;
}

.alert-error {
  background: rgba(220, 38, 38, 0.08);
  color: #b42318;
}

.input-group {
  width: 100%;
  margin-top: 28px;
}

.input-group input {
  width: 100%;
  height: 58px;
  padding: 0 18px;
  border-radius: 0;
  border: 1px solid var(--border-strong);
  outline: none;
  font: inherit;
  background: rgba(255, 251, 245, 0.96);
  text-align: center;
}

.btn {
  border: 1px solid var(--primary-color);
  cursor: pointer;
  font: inherit;
}

.btn-primary {
  background: var(--primary-color);
  color: #fff;
}

.login-btn {
  width: 100%;
  margin-top: 16px;
  height: 58px;
  padding: 0 16px;
  border-radius: 0;
  font-weight: 700;
  letter-spacing: 0.08em;
  justify-self: center;
}

.app-container { position: relative; z-index: 1; min-height: 100vh; display: grid; grid-template-columns: clamp(156px, 14vw, 220px) minmax(0, 1fr); }

.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; background: rgba(255, 251, 245, 0.52); border-right: 1px solid rgba(157, 22, 28, 0.14); backdrop-filter: blur(10px); }

.sidebar-header {
  padding: 28px 20px 18px;
  border-bottom: 1px solid rgba(157, 22, 28, 0.14);
}

.logo {
  display: grid;
  grid-template-columns: 1fr;
  gap: 4px;
  color: var(--primary-color);
  font-size: 22px;
  font-family: 'Noto Serif SC', 'Songti SC', 'STSong', 'SimSun', 'Source Han Serif SC', serif;
}

.sidebar-section { flex: 1; padding: 18px 12px; overflow: auto; }

.section-header {
  margin: 0 8px 10px;
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: none;
}

.nav-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item,
.logout-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 0;
  color: var(--text-primary);
  text-decoration: none;
  transition: 0.2s ease;
}

.nav-item:hover,
.logout-btn:hover {
  background: rgba(157, 22, 28, 0.04);
}

.nav-item.active {
  background: transparent;
  color: var(--primary-color);
  font-weight: 700;
  border-left: 3px solid var(--primary-color);
  padding-left: 11px;
}

.sidebar-footer {
  padding: 12px;
  border-top: 1px solid rgba(157, 22, 28, 0.14);
}

.logout-btn {
  width: 100%;
  border: 1px solid rgba(157, 22, 28, 0.14);
  background: rgba(255, 251, 245, 0.76);
  cursor: pointer;
}

.main-content { min-width: 0; padding: 28px 18px 28px 28px; }

.toast {
  position: fixed;
  right: 22px;
  bottom: 22px;
  padding: 12px 16px;
  border-radius: 0;
  color: #fff;
  background: rgba(26, 26, 26, 0.92);
}

.toast.error {
  background: #b42318;
}

@media (max-width: 900px) {
  .app-container {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }

  .main-content {
    padding: 18px;
  }
}
</style>
