import { ref } from 'vue'
import { resolveBackendUrl } from '../api'

const TOKEN_KEY = 'admin_token'
const EXPIRES_KEY = 'admin_token_expires'

export const isLoggedIn = ref(false)
export const isCheckingAuth = ref(true)
export const password = ref('')
export const loginError = ref('')

export function getAdminToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function getAdminAuthHeaders() {
  const token = getAdminToken()
  const headers: Record<string, string> = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EXPIRES_KEY)
  isLoggedIn.value = false
  isCheckingAuth.value = false
  password.value = ''
  loginError.value = ''
}

export async function verifyToken() {
  const token = getAdminToken()
  if (!token) {
    isCheckingAuth.value = false
    return false
  }

  try {
    const response = await fetch(resolveBackendUrl('/admin/config'), {
      headers: getAdminAuthHeaders(),
    })
    if (!response.ok) {
      logout()
      return false
    }

    const data = await response.json()
    isLoggedIn.value = Boolean(data.success)
    if (!data.success) {
      logout()
      return false
    }
  } catch {
    logout()
    return false
  }

  isCheckingAuth.value = false
  return true
}

export async function login() {
  if (!password.value.trim()) {
    loginError.value = '请输入管理员密码'
    return false
  }

  try {
    const response = await fetch(resolveBackendUrl('/admin/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    })
    const data = await response.json()

    if (!data.success) {
      loginError.value = data.error || '登录失败'
      return false
    }

    localStorage.setItem(TOKEN_KEY, data.token)
    localStorage.setItem(EXPIRES_KEY, String(Date.now() + (data.expires_in || 24 * 3600) * 1000))
    isLoggedIn.value = true
    loginError.value = ''
    return true
  } catch {
    loginError.value = '登录请求失败'
    return false
  }
}

export function initializeAdminAuth() {
  const token = getAdminToken()
  const expiresAt = localStorage.getItem(EXPIRES_KEY)

  if (!token) {
    isCheckingAuth.value = false
    return
  }

  if (expiresAt && Date.now() > Number(expiresAt)) {
    logout()
    loginError.value = '登录已过期，请重新登录'
    return
  }

  void verifyToken()
}
