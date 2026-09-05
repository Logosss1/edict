import { test, expect } from '@playwright/test'

const definitions = [
  { modelId: 'gpt-5.6-sol', levels: ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'], source: 'catalog' },
  { modelId: 'restricted', levels: ['default', 'low', 'high'], source: 'provider' },
  { modelId: 'unknown-alias', levels: ['default'], source: 'unknown' },
]
const capabilities = () => ({
  ok: true,
  models: definitions.map(item => ({
    ...item, model: `fixture/${item.modelId}`, providerId: 'fixture', warnings: [],
    runtimeLevels: item.levels.map(level => level === 'none' ? 'minimal' : level),
    mapping: Object.fromEntries(item.levels.map(level => [level, level === 'none' ? 'minimal' : level])),
    wireMapping: Object.fromEntries(item.levels.map(level => [level, level])),
  })),
  agents: [
    { agentId: 'taizi', model: 'fixture/gpt-5.6-sol' },
    { agentId: 'zhongshu', model: 'fixture/gpt-5.6-sol' },
    { agentId: 'menxia', model: 'fixture/restricted' },
  ],
})

test.beforeEach(async ({ request }) => {
  const result = await (await request.get('/api/yushufang/rooms')).json()
  for (const room of result.rooms || []) {
    if (!['concluded', 'cancelled', 'archived'].includes(room.phase)) {
      await request.post('/api/yushufang/disband', { data: { roomId: room.roomId } })
    }
  }
})

async function fixture(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('edict-ceremony-seen', '1')
    window.edictDesktop = {
      listProviders: async () => [{
        id: 'fixture', name: 'Local fixture', baseUrl: 'http://localhost/v1', secretStored: true,
        models: ['gpt-5.6-sol', 'restricted', 'unknown-alias'], defaultModel: 'gpt-5.6-sol',
      }],
      probeModelThinking: async payload => {
        window.testProbes = [...(window.testProbes || []), payload]
        return { ok: true }
      },
    }
  })
  await page.route('**/api/model-capabilities', route => route.fulfill({ json: capabilities() }))
  await page.route('**/api/agent-config', route => route.fulfill({ json: {
    agents: capabilities().agents.map(item => ({ id: item.agentId, label: item.agentId, model: item.model })),
  } }))
  await page.goto('/')
  const dismiss = page.getByRole('button', { name: /免礼/ })
  if (await dismiss.isVisible()) await dismiss.click()
}

test('model page shows exact levels, blocks stale choice, and probes only after consent', async ({ page }) => {
  await fixture(page)
  let applied
  await page.route('**/api/set-model-profile', async route => {
    applied = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true, agentCount: 3 } })
  })
  await page.getByRole('tab', { name: /模型配置/ }).click()
  await expect(page.getByRole('radio', { name: 'max', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'ultra', exact: true })).toHaveCount(0)
  await page.getByRole('radio', { name: 'max', exact: true }).check()
  await page.getByRole('checkbox', { name: /我确认将此配置应用/ }).check()
  await page.getByRole('button', { name: '确认应用到全部 Agent' }).click()
  expect(applied.thinkingDefault).toBe('max')

  await page.getByRole('combobox', { name: '默认模型', exact: true }).selectOption('restricted')
  await expect(page.getByRole('alert').filter({ hasText: '原档位 max' })).toBeVisible()
  await expect(page.getByRole('button', { name: '确认应用到全部 Agent' })).toBeDisabled()
  await expect(page.getByRole('radio', { name: 'max', exact: true })).toHaveCount(0)
  await page.getByRole('radio', { name: 'high', exact: true }).check()
  await page.getByRole('combobox', { name: '默认模型', exact: true }).selectOption('unknown-alias')
  await expect(page.getByRole('radio', { name: '模型默认', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'high', exact: true })).toHaveCount(0)

  await page.getByRole('combobox', { name: '默认模型', exact: true }).selectOption('gpt-5.6-sol')
  await page.getByText('检测与高级配置', { exact: true }).click()
  await page.getByRole('checkbox', { name: 'max', exact: true }).check()
  await expect(page.getByRole('button', { name: '检测选中档位' })).toBeDisabled()
  expect(await page.evaluate(() => window.testProbes || [])).toHaveLength(0)
  await page.getByRole('checkbox', { name: /我确认向此供应商发送/ }).check()
  await page.getByRole('button', { name: '检测选中档位' }).click()
  await expect.poll(() => page.evaluate(() => (window.testProbes || []).length)).toBe(1)
  expect(await page.evaluate(() => window.testProbes[0])).toEqual({ model: 'fixture/gpt-5.6-sol', levels: ['max'], confirmed: true })
  await expect(page.getByRole('status').filter({ hasText: '检测结束' })).toBeVisible()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({ path: `test-results/thinking-model-${width}.png`, fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    expect(await page.locator('.provider-editor').evaluate(element => element.clientWidth)).toBeGreaterThan(260)
  }
})

test('private room offers intersection of invited models without downgrading selection', async ({ page }) => {
  await fixture(page)
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByRole('radio', { name: 'max', exact: true }).check()
  await page.getByRole('checkbox', { name: '侍中', exact: true }).check()
  await expect(page.getByRole('radio', { name: 'max', exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert').filter({ hasText: '原档位 max' })).toBeVisible()
  await page.getByLabel('议题', { exact: true }).fill('不同模型共同档位')
  await expect(page.getByRole('button', { name: '下诏入内', exact: true })).toBeDisabled()
  await page.getByRole('radio', { name: 'high', exact: true }).check()
  await expect(page.getByRole('button', { name: '下诏入内', exact: true })).toBeEnabled()
})

test('existing private room can explicitly change an incompatible saved level before sending', async ({ page }) => {
  await fixture(page)
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill('继续旧会话')
  await page.getByRole('radio', { name: 'high', exact: true }).check()
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await page.route('**/api/model-capabilities', route => {
    const data = capabilities()
    data.models[0].levels = ['default', 'low']
    return route.fulfill({ json: data })
  })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert').filter({ hasText: '原档位 high' })).toBeVisible()
  await page.getByLabel('皇上发言').fill('采用兼容档位继续')
  await expect(page.getByRole('button', { name: '传旨', exact: true })).toBeDisabled()
  await page.getByRole('radio', { name: 'low', exact: true }).check()
  const sent = page.waitForRequest(request => request.url().endsWith('/api/yushufang/speak'))
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  expect((await sent).postDataJSON().thinkingDefault).toBe('low')
  await expect(page.locator('.yushu-phase')).toHaveText('待命', { timeout: 15000 })
})
