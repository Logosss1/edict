import { test, expect } from '@playwright/test'
import path from 'node:path'

async function openSettings(page) {
  await page.route('http://settings.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'index.html'
    return route.fulfill({ path: path.resolve('settings', name) })
  })
  await page.addInitScript(() => {
    window.settingsCalls = []
    window.capabilitiesFail = false
    const snapshot = {
      defaultModel: 'custom/gpt-5.6', defaultThinking: 'ultra',
      agents: [{ id: 'taizi', thinkingDefault: 'max' }],
    }
    window.edictDesktop = {
      listProviders: async () => [{ id: 'custom', name: '测试供应商', models: ['gpt-5.6', 'basic', 'future'] }],
      getDiagnostics: async () => ({}),
      getOpenClawSnapshot: async () => snapshot,
      getAgentBindings: async () => ({ agents: [{ agentId: 'taizi', label: '太子', model: 'custom/gpt-5.6', providerId: 'custom', modelId: 'gpt-5.6' }] }),
      dashboardApi: async () => {
        if (window.capabilitiesFail) throw new Error('连接已断开')
        return { ok: true, models: [
          { model: 'custom/gpt-5.6', levels: ['none', 'low', 'high', 'max'], runtimeLevels: ['minimal', 'low', 'high', 'max'], mapping: { none: 'minimal', max: 'max' }, wireMapping: { none: 'none', max: 'max' }, source: 'catalog' },
          { model: 'custom/basic', levels: ['low'], runtimeLevels: ['low'], mapping: {}, source: 'provider' },
          { model: 'custom/future', levels: ['low', 'ultra'], runtimeLevels: ['low'], mapping: {}, source: 'manual' },
        ], agents: [{ agentId: 'taizi', model: 'custom/gpt-5.6' }] }
      },
      patchAgent: async value => { window.settingsCalls.push(value) },
      patchGlobal: async value => { window.settingsCalls.push(value); Object.assign(snapshot, { defaultThinking: value.defaultThinking }) },
      openDashboard: async () => { window.settingsCalls.push('dashboard') },
    }
  })
  await page.goto('http://settings.test/')
  await expect(page.locator('#agent-status')).toHaveText('已读取')
}

test('native settings use model capabilities and keep incompatible values explicit', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await openSettings(page)
  await page.locator('[data-tab="runtime"]').click()
  await expect(page.locator('#global-thinking')).toHaveValue('ultra')
  await expect(page.locator('#global-thinking option[value="ultra"]')).toHaveJSProperty('disabled', true)
  await expect(page.locator('#global-thinking')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#global-thinking-details')).toContainText('不适用')
  await page.locator('#global-thinking').selectOption('max')
  await expect(page.locator('#global-thinking-details')).toContainText('已知模型定义')
  await page.locator('#global-model').selectOption('basic')
  await expect(page.locator('#global-thinking')).toHaveValue('max')
  await expect(page.locator('#global-thinking option[value="max"]')).toHaveJSProperty('disabled', true)
  await page.locator('#global-thinking').selectOption('low')
  await page.locator('#save-runtime').click()
  await expect.poll(() => page.evaluate(() => window.settingsCalls[0])).toMatchObject({ defaultModel: 'custom/basic', defaultThinking: 'low' })

  await page.locator('[data-tab="agents"]').click()
  await page.locator('#agent-model').selectOption('basic')
  await expect(page.locator('#agent-thinking')).toHaveValue('max')
  await expect(page.locator('#agent-thinking-details')).toContainText('custom/gpt-5.6')
  await expect(page.locator('#agent-binding')).toContainText('尚未应用')
  await page.locator('#save-agent-policy').click()
  await expect.poll(() => page.evaluate(() => window.settingsCalls.find(call => call?.agentId))).toMatchObject({ agentId: 'taizi', patch: { thinkingDefault: 'max' } })
  await page.locator('#agent-thinking').selectOption('none')
  await expect(page.locator('#agent-thinking-details')).toContainText('none → minimal → none')
  await page.locator('#save-agent-policy').click()
  await expect.poll(() => page.evaluate(() => window.settingsCalls.filter(call => call?.agentId).at(-1))).toMatchObject({ patch: { thinkingDefault: 'none' } })
  await page.locator('#tab-agents [data-manage-capabilities]').click()
  await expect.poll(() => page.evaluate(() => window.settingsCalls.at(-1))).toBe('dashboard')
  await page.screenshot({ path: 'test-results/settings-thinking-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/settings-thinking-mobile.png', fullPage: true })
  expect(errors).toEqual([])
})

test('native settings recover from capability failures without guessing ultra', async ({ page }) => {
  await openSettings(page)
  await page.evaluate(() => { window.capabilitiesFail = true })
  await page.locator('[data-tab="runtime"]').click()
  await expect(page.locator('#global-thinking-details')).toContainText('读取失败')
  await expect(page.locator('#global-thinking option[value="ultra"]')).toHaveJSProperty('disabled', true)
  await expect(page.locator('#global-thinking option[value="default"]')).toHaveJSProperty('disabled', false)
  await page.evaluate(() => { window.capabilitiesFail = false })
  await page.locator('#tab-runtime [data-refresh-capabilities]').click()
  await expect(page.locator('#global-thinking-details')).not.toContainText('读取失败')
  await page.locator('#global-model').selectOption('future')
  await expect(page.locator('#global-thinking option[value="ultra"]')).toHaveJSProperty('disabled', true)
  await expect(page.locator('#global-thinking option[value="ultra"]')).toContainText('运行时不支持')
  await page.locator('#global-thinking').selectOption('default')
  await page.locator('#save-runtime').click()
  await expect.poll(() => page.evaluate(() => window.settingsCalls[0])).toMatchObject({ defaultModel: 'custom/future', defaultThinking: 'default' })
})
