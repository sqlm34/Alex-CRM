import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e', testMatch: 'crm-redesign.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5198', channel: process.platform === 'win32' ? 'msedge' : undefined },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198 --strictPort',
    env: { VITE_API_URL: 'http://127.0.0.1:5198' },
    url: 'http://127.0.0.1:5198', reuseExistingServer: false,
  },
})
