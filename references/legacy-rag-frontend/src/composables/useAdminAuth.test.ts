import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAdminAuthHeaders,
  getAdminToken,
  initializeAdminAuth,
  isCheckingAuth,
  isLoggedIn,
  login,
  loginError,
  logout,
  password,
  verifyToken,
} from './useAdminAuth'

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(body) } as Response
}

describe('useAdminAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    isLoggedIn.value = false
    isCheckingAuth.value = true
    password.value = ''
    loginError.value = ''
  })

  it('stores and clears admin tokens', () => {
    localStorage.setItem('admin_token', 'token')

    expect(getAdminToken()).toBe('token')
    expect(getAdminAuthHeaders()).toEqual({ Authorization: 'Bearer token' })

    logout()

    expect(getAdminToken()).toBeNull()
    expect(isLoggedIn.value).toBe(false)
    expect(isCheckingAuth.value).toBe(false)
  })

  it('rejects empty login passwords before requesting', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(login()).resolves.toBe(false)

    expect(loginError.value).toBe('请输入管理员密码')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('logs in and persists token on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true, token: 'token', expires_in: 60 }))
    password.value = 'secret'

    await expect(login()).resolves.toBe(true)

    expect(localStorage.getItem('admin_token')).toBe('token')
    expect(isLoggedIn.value).toBe(true)
    expect(loginError.value).toBe('')
  })

  it('logs out when token verification fails', async () => {
    localStorage.setItem('admin_token', 'token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: false }))

    await expect(verifyToken()).resolves.toBe(false)

    expect(getAdminToken()).toBeNull()
    expect(isLoggedIn.value).toBe(false)
  })

  it('expires stale stored sessions during initialization', () => {
    localStorage.setItem('admin_token', 'token')
    localStorage.setItem('admin_token_expires', String(Date.now() - 1000))

    initializeAdminAuth()

    expect(getAdminToken()).toBeNull()
    expect(loginError.value).toBe('登录已过期，请重新登录')
  })
})
