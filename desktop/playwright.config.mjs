import { defineConfig } from '@playwright/test'

const port = process.env.EDICT_UI_TEST_PORT || '43819'
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.pw.mjs',
  workers: 1,
  timeout: 45000,
  use: { baseURL: `http://127.0.0.1:${port}`, channel: process.env.PLAYWRIGHT_CHANNEL, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'python3 ../upstream/tests/innercourt_ui_server.py',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
  },
})
