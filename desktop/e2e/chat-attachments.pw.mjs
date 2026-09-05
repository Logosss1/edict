import { test, expect } from '@playwright/test'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const file = (name, content = 'ATTACHMENT_MARKER: budget 128') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(content) })

test.beforeEach(async ({ request }) => {
  const result = await (await request.get('/api/yushufang/rooms')).json()
  for (const room of result.rooms || []) {
    if (!['concluded', 'cancelled', 'archived'].includes(room.phase)) {
      await request.post('/api/yushufang/disband', { data: { roomId: room.roomId } })
    }
  }
})

async function room(page, topic, prince = false) {
  await page.goto('/')
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  if (prince) await page.getByRole('button', { name: '太子密谈', exact: true }).click()
  else await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill(topic)
  await page.getByRole('button', { name: prince ? '召太子入内' : '下诏入内', exact: true }).click()
}
async function upload(page, files) {
  await page.getByLabel('选择附件', { exact: true }).setInputFiles(files)
  await expect(page.getByRole('list', { name: '待发送附件' })).toBeVisible()
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled()
}

test('prince and minister uploads retain draft, preserve files after archive, isolate rooms', async ({ page, request }) => {
  const topic = '附件验收太子密谈'
  await room(page, topic, true)
  await upload(page, [file('预算说明.md'), { name: '参考.png', mimeType: 'image/png', buffer: png }])
  await page.getByLabel('皇上发言').fill('请分析上传资料')
  await page.route('**/api/yushufang/speak', route => route.fulfill({ status: 503, json: { ok: false, error: '测试网络中断' } }))
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await expect(page.getByLabel('皇上发言')).toHaveValue('请分析上传资料')
  await expect(page.getByRole('list', { name: '待发送附件' }).locator('li')).toHaveCount(2)
  await page.reload()
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.locator('.yushu-history button').filter({ hasText: topic }).click()
  await expect(page.getByLabel('皇上发言')).toHaveValue('请分析上传资料')
  await expect(page.getByRole('list', { name: '待发送附件' }).locator('li')).toHaveCount(2)
  await page.unroute('**/api/yushufang/speak')
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await expect(page.getByRole('log').getByRole('link', { name: '预算说明.md' })).toBeVisible()
  await expect(page.getByRole('log').getByRole('img', { name: '参考.png' })).toBeVisible()
  await expect(page.locator('.yushu-phase')).toHaveText('待命', { timeout: 15000 })
  const href = await page.getByRole('log').getByRole('link', { name: '预算说明.md' }).getAttribute('href')
  const query = new URL(href, 'http://localhost').searchParams
  const download = await request.get(href)
  expect(await download.text()).toContain('ATTACHMENT_MARKER')
  expect((await request.post('/api/chat-attachments/remove', { data: { scope: query.get('scope'), id: query.get('id') } })).status()).toBe(400)
  await page.getByRole('button', { name: '结束议事', exact: true }).click()
  await page.getByRole('button', { name: '归档', exact: true }).click()
  expect((await request.get(href)).status()).toBe(200)
  await page.screenshot({ path: 'test-results/attachments-prince-archived.png', fullPage: true })
  await page.getByRole('button', { name: '新议事', exact: true }).first().click()
  await page.getByRole('checkbox', { name: '中书令', exact: true }).check()
  await page.getByLabel('议题', { exact: true }).fill('附件隔离臣子议事')
  await page.getByRole('button', { name: '下诏入内', exact: true }).click()
  await upload(page, file('臣子资料.txt'))
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('臣子资料.txt')
  await expect(page.getByRole('log')).not.toContainText('预算说明.md')
  const rooms = await (await request.get('/api/yushufang/rooms')).json()
  const ministers = rooms.rooms.find(item => item.topic === '附件隔离臣子议事')
  const forged = await request.post('/api/yushufang/speak', { data: { roomId: ministers.roomId, message: 'forged', attachmentIds: [query.get('id')] } })
  expect(forged.status()).toBe(400)
})

test('upload errors, retry, remove, paste, drop and narrow layout', async ({ page }) => {
  await room(page, '上传交互验收')
  let attempts = 0
  await page.route('**/api/chat-attachments?*', async route => {
    if (route.request().method() === 'POST' && ++attempts === 1) return route.fulfill({ status: 500, json: { ok: false, error: '测试上传失败' } })
    await route.continue()
  })
  await page.getByLabel('选择附件', { exact: true }).setInputFiles(file('重试资料.txt'))
  await expect(page.getByRole('list', { name: '待发送附件' })).toContainText('测试上传失败')
  await expect(page.getByRole('button', { name: '传旨', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '重试上传 重试资料.txt', exact: true }).click()
  await expect(page.getByRole('list', { name: '待发送附件' })).not.toContainText('测试上传失败')
  await expect(page.getByRole('button', { name: '传旨', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '移除 重试资料.txt', exact: true }).click()
  await expect(page.getByRole('list', { name: '待发送附件' })).toHaveCount(0)
  await page.getByLabel('皇上发言').evaluate(element => {
    const data = new DataTransfer()
    data.items.add(new File(['paste marker'], '粘贴资料.txt', { type: 'text/plain' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.getByRole('list', { name: '待发送附件' })).toContainText('粘贴资料.txt')
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled()
  await page.locator('.chat-composer').evaluate(element => {
    const data = new DataTransfer()
    data.items.add(new File(['drop marker'], '拖放资料.md', { type: 'text/markdown' }))
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(page.getByRole('list', { name: '待发送附件' })).toContainText('拖放资料.md')
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled()
  const longName = `${'long_attachment_name_'.repeat(8)}.txt`
  await upload(page, file(longName))
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.getByLabel('皇上发言').scrollIntoViewIfNeeded()
    expect(await page.locator('.chat-composer').evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `test-results/attachments-composer-${width}.png`, fullPage: true })
  }
})

test('court files reach replies and history, failed attachment analysis is not simulated', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: '朝堂议政', exact: true }).click()
  await page.getByRole('button', { name: /中书省.*中书令/ }).click()
  await page.getByRole('button', { name: /门下省.*侍中/ }).click()
  await page.getByPlaceholder('或自定义议题...').fill('朝议附件完整流程')
  await page.getByRole('button', { name: /开始朝议/ }).click()
  await upload(page, file('朝议材料.md'))
  await page.getByLabel('朝堂发言').fill('先读资料')
  await page.getByRole('button', { name: '发言', exact: true }).click()
  await expect(page.getByRole('link', { name: '朝议材料.md' })).toBeVisible()
  await expect(page.getByText('已收到本场附件，按资料中的预算和验收要求提出方案。')).toBeVisible()
  await page.getByLabel('朝堂发言').fill('UI_ATTACHMENT_FAIL')
  await page.getByRole('button', { name: '发言', exact: true }).click()
  await expect(page.getByLabel('朝堂发言')).toHaveValue('UI_ATTACHMENT_FAIL')
  await expect(page.getByText(/未使用模拟回复/)).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: '朝堂议政', exact: true }).click()
  await page.locator('.court-history button').filter({ hasText: '朝议附件完整流程' }).click()
  await expect(page.getByRole('link', { name: '朝议材料.md' })).toBeVisible()
  await expect(page.getByLabel('朝堂发言')).toHaveValue('UI_ATTACHMENT_FAIL')
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
    await page.screenshot({ path: `test-results/attachments-court-${width}.png`, fullPage: true })
  }
})
