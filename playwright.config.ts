import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  workers: 1,
  timeout: 45000,
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5186 --strictPort',
    url: 'http://127.0.0.1:5186',
    reuseExistingServer: !process.env.CI,
    env: { VITE_API_URL: 'http://127.0.0.1:5199', VITE_GOOGLE_MAPS_API_KEY: '' },
  },
  use: {
    baseURL: 'http://127.0.0.1:5186',
    browserName: 'chromium',
    launchOptions: { channel: process.platform === 'win32' ? 'msedge' : undefined },
    screenshot: 'only-on-failure',
  },
})
