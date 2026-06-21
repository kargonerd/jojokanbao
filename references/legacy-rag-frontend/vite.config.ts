/// <reference types="vitest" />

import type { IncomingMessage } from 'node:http'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

function bypassHtmlRequest(req: IncomingMessage) {
  const accept = req.headers.accept
  if (req.method === 'GET' && typeof accept === 'string' && accept.includes('text/html')) {
    return req.url
  }
  return undefined
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '', '')
  const backendTarget = env.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:9002'

  return {
    plugins: [vue()],
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        include: ['src/utils/**/*.ts', 'src/composables/**/*.ts'],
        exclude: ['src/**/*.test.ts'],
      },
    },
    server: {
      port: 3000,
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/notebooks': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/admin/login': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/admin/config': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/admin/accounts': {
          target: backendTarget,
          changeOrigin: true,
          bypass: bypassHtmlRequest,
        },
        '^/admin/accounts/.+$': {
          target: backendTarget,
          changeOrigin: true,
        },
        '^/admin/notebooks(?:/.+)?$': {
          target: backendTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
