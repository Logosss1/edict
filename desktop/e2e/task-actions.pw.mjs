import { test, expect } from '@playwright/test'

async function readTask(request, taskId) {
  const response = await request.get('/api/live-status')
  const payload = await response.json()
  return (payload.tasks || []).find((task) => task.id === taskId)
}

async function createTask(request, label) {
  const created = await request.post('/api/create-task', {
    data: { title: `按钮动作验收 · ${label} · ${Date.now()}`, org: '中书省', priority: 'normal' },
  })
  expect(created.ok()).toBeTruthy()
  const taskId = (await created.json()).taskId
  expect(taskId).toBeTruthy()
  return taskId
}

async function waitForState(request, taskId, state) {
  await expect.poll(async () => (await readTask(request, taskId))?.state, { timeout: 10_000 }).toBe(state)
}

async function openCard(page, taskId) {
  const card = page.locator('.edict-card').filter({ hasText: taskId })
  await expect(card).toBeVisible({ timeout: 15_000 })
  return card
}

async function confirmWithReason(page, reason, okLabel) {
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder('输入原因（可留空）').fill(reason)
  const confirm = dialog.getByRole('button', { name: okLabel })
  await expect(confirm).toBeEnabled()
  // Do not force clicks: that hides real pointer/overlay positioning defects.
  await confirm.click()
}

test('任务卡片的叫停会进入阻塞状态', async ({ page, request }) => {
  const taskId = await createTask(request, '卡片叫停')
  await page.goto('/')
  const card = await openCard(page, taskId)
  await card.getByRole('button', { name: /叫停/ }).click()
  await confirmWithReason(page, '卡片叫停验收原因', '确认叫停')
  await waitForState(request, taskId, 'Blocked')
  expect((await readTask(request, taskId)).block).toBe('卡片叫停验收原因')
})

test('任务卡片的取消会进入已取消状态', async ({ page, request }) => {
  const taskId = await createTask(request, '卡片取消')
  await page.goto('/')
  const card = await openCard(page, taskId)
  await card.getByRole('button', { name: /取消/ }).click()
  await confirmWithReason(page, '卡片取消验收原因', '确认取消')
  await waitForState(request, taskId, 'Cancelled')
  expect((await readTask(request, taskId)).block).toBe('卡片取消验收原因')
})

test('进入任务详情后的取消任务会执行真实取消', async ({ page, request }) => {
  const taskId = await createTask(request, '详情取消')
  await page.goto('/')
  const card = await openCard(page, taskId)
  await card.click()
  await page.locator('.modal').getByRole('button', { name: '🚫 取消任务' }).click()
  await confirmWithReason(page, '详情取消验收原因', '确认取消')
  await waitForState(request, taskId, 'Cancelled')
  expect((await readTask(request, taskId)).block).toBe('详情取消验收原因')
})

test('确认框的返回不会改变任务状态', async ({ page, request }) => {
  const taskId = await createTask(request, '确认返回')
  await page.goto('/')
  const card = await openCard(page, taskId)
  await card.getByRole('button', { name: /叫停/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const viewport = page.viewportSize()
  const expectedOverlay = { x: 0, y: 0, width: viewport.width, height: viewport.height }
  expect(await page.locator('.confirm-bg').boundingBox()).toEqual(expectedOverlay)
  await page.mouse.move(5, 5)
  expect(await page.locator('.confirm-bg').boundingBox()).toEqual(expectedOverlay)
  await dialog.getByRole('button', { name: '返回' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.modal')).toBeHidden()
  expect((await readTask(request, taskId)).state).toBe('Taizi')
})

test('输入原因后确认会把原因写入任务记录', async ({ page, request }) => {
  const taskId = await createTask(request, '原因确认')
  await page.goto('/')
  const card = await openCard(page, taskId)
  await card.getByRole('button', { name: /取消/ }).click()
  await confirmWithReason(page, '明确写入的取消原因', '确认取消')
  await waitForState(request, taskId, 'Cancelled')
  const task = await readTask(request, taskId)
  expect(task.now).toContain('明确写入的取消原因')
  expect(task.flow_log.some((entry) => entry.remark.includes('明确写入的取消原因'))).toBeTruthy()
})

test('已取消任务可以从详情删除记录', async ({ page, request }) => {
  const taskId = await createTask(request, '删除记录')
  await page.goto('/')
  const card = await openCard(page, taskId)
  await card.getByRole('button', { name: /取消/ }).click()
  await confirmWithReason(page, '删除前取消', '确认取消')
  await waitForState(request, taskId, 'Cancelled')

  const cancelledCard = await openCard(page, taskId)
  await cancelledCard.click()
  await page.locator('.modal').getByRole('button', { name: /删除记录/ }).click()
  const deleteDialog = page.getByRole('dialog')
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: '永久删除' }).click()
  await expect.poll(async () => (await readTask(request, taskId))?.id, { timeout: 10_000 }).toBeUndefined()
})
