import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5186', channel: process.platform === 'win32' ? 'msedge' : undefined },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5186 --strictPort', url: 'http://127.0.0.1:5186', reuseExistingServer: !process.env.CI },
})
