import { test, expect } from '@playwright/test'

test('Android splash ends after five seconds and releases the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.install()
  await page.addInitScript(() => {
    Object.assign(window, {
      androidBridge: {},
      Capacitor: {
        PluginHeaders: [{ name: 'App', methods: [
          { name: 'addListener', rtype: 'callback' },
          { name: 'removeListener', rtype: 'promise' },
        ] }],
        nativeCallback: () => 'test-listener',
        nativePromise: async () => ({}),
      },
    })
  })
  await page.route('**/*', route => new URL(route.request().url()).port === '5186'
    ? route.continue() : route.fulfill({ json: [] }))
  await page.goto('/')
  await expect(page.locator('.startup-splash')).toBeVisible()
  await expect(page.locator('.startup-splash')).toHaveCSS('animation-delay', '4.2s')
  await page.clock.runFor(4000)
  await expect(page.locator('.startup-splash')).toHaveCount(1)
  await page.clock.runFor(1100)
  await expect(page.locator('.startup-splash')).toHaveCount(0)
  await expect(page.locator('html')).not.toHaveClass(/android-startup/)
  await expect(page.locator('.startup-app')).not.toHaveAttribute('inert')
})
