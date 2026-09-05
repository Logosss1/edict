import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  const result = await (await request.get('/api/yushufang/rooms')).json()
  for (const room of result.rooms || []) {
    if (!['concluded', 'cancelled', 'archived'].includes(room.phase)) {
      await request.post('/api/yushufang/disband', { data: { roomId: room.roomId } })
    }
  }
})

test('roster, private prince, explicit joint invite, serial queue, approvals and archive', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => dialog.accept())
  await page.goto('/')
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await expect(page.getByRole('heading', { name: '召见臣子' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: '中书令', exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: '太子', exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/innercourt-empty-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '太子密谈', exact: true }).click()
  await page.getByLabel('议题', { exact: true }).fill('只给太子的独立密谈')
  await page.getByRole('button', { name: '召太子入内' }).click()
  await expect(page.locator('.yushu-participants')).toContainText('太子')
  await expect(page.getByRole('checkbox', { name: '中书令', exact: true })).toBeDisabled()
  await page.getByLabel('皇上发言').fill('密谈标记：PRINCE_ONLY')
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await expect(page.locator('.yushu-phase')).toHaveText('待命', { timeout: 15000 })
  await page.screenshot({ path: 'test-results/innercourt-prince-desktop.png', fullPage: true })

  await page.getByRole('button', { name: '结束议事', exact: true }).click()
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await page.getByRole('button', { name: '新议事', exact: true }).first().click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByRole('checkbox', { name: '侍中', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill('讨论发布风险和实施方案')
  await page.getByRole('radio', { name: 'high', exact: true }).check()
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await page.getByRole('button', { name: '邀请太子列席' }).click()
  await expect(page.locator('.yushu-participants')).toContainText('太子')
  await expect(page.getByRole('log')).not.toContainText('PRINCE_ONLY')
  await page.getByRole('checkbox', { name: '工部尚书', exact: true }).check()
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await expect(page.locator('.yushu-participant')).toHaveCount(4)
  await expect(page.getByRole('checkbox', { name: '户部尚书', exact: true })).toBeDisabled()
  await page.getByLabel('罢黜工部尚书出殿').click()
  await expect(page.locator('.yushu-participant')).toHaveCount(3)

  await page.getByLabel('皇上发言').fill('请按顺序给出实施方案')
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await expect(page.getByRole('button', { name: '结束议事', exact: true })).toBeDisabled()
  await page.getByLabel('皇上发言').fill('第二轮请补充验收')
  await page.getByRole('button', { name: '排队传旨', exact: true }).click()
  await expect(page.getByRole('region', { name: '排队圣谕' })).toContainText('第二轮请补充验收')
  await page.getByLabel('皇上发言').fill('第三轮撤回')
  await page.getByRole('button', { name: '排队传旨', exact: true }).click()
  await page.getByLabel('撤回第2条圣谕').click()
  await page.screenshot({ path: 'test-results/innercourt-running-desktop.png', fullPage: true })
  await expect(page.locator('.yushu-phase')).toHaveText('待命', { timeout: 20000 })
  await expect(page.locator('.yushu-message.official')).toHaveCount(6)
  await expect(page.getByRole('log')).not.toContainText('第三轮撤回')
  await expect(page.getByRole('log')).not.toContainText('PRINCE_ONLY')
  await page.getByRole('button', { name: '结束议事', exact: true }).click()
  await page.getByRole('button', { name: '准奏', exact: true }).first().click()
  await page.getByRole('button', { name: '下旨执行', exact: true }).first().click()
  await expect(page.locator('.yushu-approvals')).toContainText('JJC-')
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await expect(page.locator('.yushu-phase')).toHaveText('已归档')
  await page.reload()
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await expect(page.locator('.yushu-history')).toContainText('讨论发布风险和实施方案')
  expect(errors).toEqual([])
})

test('narrow window keeps form controls inside the viewport and preserves failed drafts', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto('/')
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill('窄窗口议事')
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await page.route('**/api/yushufang/speak', route => route.fulfill({ status: 400, json: { ok: false, error: '模拟连接失败' } }))
  await page.getByLabel('皇上发言').fill('发送失败也要保留这段话')
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await expect(page.getByLabel('皇上发言')).toHaveValue('发送失败也要保留这段话')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.screenshot({ path: 'test-results/innercourt-narrow.png', fullPage: true })
})

test('full settings uses the dashboard dark theme and editable provider fields', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.edictDesktop = {
      listProviders: async () => [],
      getDiagnostics: async () => ({ startupState: 'ready', runtimeOptions: {} }),
      getOpenClawSnapshot: async () => ({ agents: [], mcpServers: [], network: { search: { enabled: true }, fetch: { enabled: true } } }),
      getAgentBindings: async () => ({ agents: [] }),
      getObservability: async () => ({ activeTasks: [], agentsStatus: {}, recentErrors: [] }),
      checkRuntime: async () => ({ ok: true, errors: [], openclawPath: '/fixture/openclaw', nodePath: '/fixture/node' }),
      saveRuntimePaths: async paths => ({ ok: !paths.openclawPath.includes('missing'), ...paths, errors: paths.openclawPath.includes('missing') ? ['未找到可执行的 OpenClaw'] : [] }),
      selectRuntimePath: async () => '/fixture/selected',
    }
  })
  await page.goto('/settings/index.html')
  await expect(page.getByRole('heading', { name: 'Edict_InnerCourt' })).toBeVisible()
  await page.locator('#provider-url').fill('https://fixture.example/v1')
  await page.locator('#provider-key').fill('fixture-secret')
  await expect(page.locator('#provider-url')).toHaveValue('https://fixture.example/v1')
  await expect(page.locator('#provider-key')).toHaveValue('fixture-secret')
  expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(7, 9, 15)')
  await page.screenshot({ path: 'test-results/settings-desktop.png', fullPage: true })
  for (const tab of ['agents', 'runtime', 'mcp', 'ops']) {
    await page.locator(`[data-tab="${tab}"]`).click()
    await expect(page.locator(`#tab-${tab}`)).toBeVisible()
  }
  await page.setViewportSize({ width: 760, height: 900 })
  await page.locator('[data-tab="providers"]').click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.screenshot({ path: 'test-results/settings-narrow.png', fullPage: true })
  expect(errors).toEqual([])
})

test('runtime repair settings show actionable failure and retain editable paths', async ({ page }) => {
  await page.addInitScript(() => {
    window.edictDesktop = {
      listProviders: async () => [], getDiagnostics: async () => ({}),
      getOpenClawSnapshot: async () => ({ agents: [], mcpServers: [], network: {} }),
      getAgentBindings: async () => ({ agents: [] }),
      checkRuntime: async () => ({ ok: true, errors: [], openclawPath: '/fixture/openclaw', nodePath: '/fixture/node' }),
      saveRuntimePaths: async paths => ({ ok: !paths.openclawPath.includes('missing'), ...paths, errors: paths.openclawPath.includes('missing') ? ['未找到可执行的 OpenClaw，请重新选择。'] : [] }),
      selectRuntimePath: async () => '/fixture/selected',
    }
  })
  await page.goto('/settings/index.html')
  await page.getByRole('button', { name: '运行依赖', exact: true }).click()
  await expect(page.locator('#dependencies-status')).toHaveText('已就绪')
  await page.getByLabel('OpenClaw 程序路径').fill('/missing/openclaw with spaces')
  await page.getByLabel('Node.js 程序路径').fill('/fixture/node')
  await page.getByRole('button', { name: '保存并检测' }).click()
  await expect(page.locator('#dependencies-status')).toHaveText('需要修复')
  await expect(page.getByLabel('OpenClaw 程序路径')).toHaveValue('/missing/openclaw with spaces')
  await expect(page.locator('#dependencies-error')).toBeFocused()
  await page.getByRole('button', { name: '选择 OpenClaw' }).click()
  await page.getByRole('button', { name: '保存并检测' }).click()
  await expect(page.locator('#dependencies-status')).toHaveText('已就绪')
  await page.screenshot({ path: 'test-results/runtime-settings-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 760, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await page.screenshot({ path: 'test-results/runtime-settings-narrow.png', fullPage: true })
})

test('partial failure pauses queued messages and retries only unfinished replies', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByRole('checkbox', { name: '侍中', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill('失败恢复 UI_FAIL_ONCE')
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await page.getByLabel('皇上发言').fill('第一轮实施方案')
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await page.getByLabel('皇上发言').fill('第二轮验收')
  await page.getByRole('button', { name: '排队传旨', exact: true }).click()
  await expect(page.locator('.yushu-phase')).toHaveText('部分回奏失败', { timeout: 15000 })
  await expect(page.locator('.yushu-message.official')).toHaveCount(1)
  await expect(page.getByRole('region', { name: '排队圣谕' })).toContainText('第二轮验收')
  await expect(page.getByRole('log')).not.toContainText('本轮议事结束')
  await page.getByLabel('皇上发言').fill('暂停期间保留的草稿')
  await expect(page.getByRole('button', { name: '传旨', exact: true })).toBeDisabled()
  await page.screenshot({ path: 'test-results/runtime-partial-failure.png', fullPage: true })
  await page.getByRole('button', { name: '重试未完成回奏' }).click()
  await expect(page.locator('.yushu-phase')).toHaveText('待命', { timeout: 20000 })
  await expect(page.locator('.yushu-message.official')).toHaveCount(4)
  await expect(page.getByLabel('皇上发言')).toHaveValue('暂停期间保留的草稿')
})

test('missing runtime prevents send, recheck restores it without losing draft', async ({ page }) => {
  let available = false
  await page.route('**/api/yushufang/runtime', route => route.fulfill({ json: { ok: available, errors: available ? [] : ['未找到可执行的 OpenClaw，请打开设置检查运行依赖。'] } }))
  await page.goto('/')
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill('运行环境恢复')
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await page.getByLabel('皇上发言').fill('不可丢失的圣谕')
  await expect(page.getByRole('button', { name: '传旨', exact: true })).toBeDisabled()
  await expect(page.getByRole('region', { name: '运行依赖' })).toContainText('未找到')
  available = true
  await page.getByRole('button', { name: '重新检测运行依赖' }).click()
  await expect(page.getByRole('button', { name: '传旨', exact: true })).toBeEnabled()
  await expect(page.getByLabel('皇上发言')).toHaveValue('不可丢失的圣谕')
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await expect(page.locator('.yushu-message.official')).toHaveCount(1, { timeout: 15000 })
})

test('御书房同一时间只允许一场，并可删除已结束密档', async ({ page, request }) => {
  page.on('dialog', dialog => dialog.accept())
  await page.goto('/')
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill('唯一进行中的御书房测试')
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await expect(page.locator('.yushu-phase')).toHaveText('待命')

  const duplicate = await request.post('/api/yushufang/open', { data: {
    topic: '不应同时出现的第二场', officials: ['menxia'], thinkingDefault: 'default', audience: 'ministers',
  } })
  expect(duplicate.status()).toBe(400)
  expect((await duplicate.json()).error).toContain('只能有一场')

  await page.getByRole('button', { name: '解散', exact: true }).click()
  await expect(page.locator('.yushu-phase')).toHaveText('已解散')
  await page.getByRole('button', { name: '删除唯一进行中的御书房测试', exact: true }).click()
  await expect(page.locator('.yushu-history')).not.toContainText('唯一进行中的御书房测试')
})

test('御书房可读取共享主会话并询问 Agent 实时进度', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill('读取共享主会话进度')
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await expect(page.locator('.yushu-phase')).toHaveText('待命')
  await expect(page.locator('.yushu-context')).toContainText('共享 Agent 主工作会话')
  await expect(page.getByRole('button', { name: '询问进度', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '询问进度', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('进度回奏', { timeout: 15000 })
  await expect(page.locator('.yushu-context')).toContainText('Agent 主工作会话')
})
