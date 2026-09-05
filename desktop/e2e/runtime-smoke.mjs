import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const userData = await mkdtemp(join(tmpdir(), 'innercourt-runtime-smoke-'))
const requests = []
const MODEL = 'gpt-5.6-sol'
const expectedVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version
const nativeOpenAIProfile = process.env.EDICT_SMOKE_PROVIDER_ID === 'openai'
const mock = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url.endsWith('/models')) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify({ data: [{ id: MODEL }] }))
  }
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
    response.writeHead(404)
    return response.end()
  }
  let body = ''
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body)
  requests.push(payload)
  if (payload.stream === false) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    return response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }))
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (requests.length === 1) {
    const prompt = JSON.stringify(payload.messages)
    const path = prompt.match(/attachments\/[^"\\\s]+\.png/)?.[0]
    assert(path, 'the normal upload path must stage the PNG')
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'read-uploaded-image', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path }) } }] }
    response.write(`data: ${JSON.stringify({ id: 'runtime-image', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'runtime-image', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
    return response.end('data: [DONE]\n\n')
  }
  const promptText = JSON.stringify(payload.messages)
  const currentQuestion = promptText.match(/本轮皇上最新圣谕：([^\\"\\n]*)/)?.[1]?.trim() || `请求${requests.length}`
  for (const [delta, finish] of [
    [{ role: 'assistant', content: `方案：先检查运行依赖，再验证实际回奏（${currentQuestion}，mock请求${requests.length}）。\n风险/验收：Finder 启动完成真实模型调用。\n待御批：无` }, null],
    [{}, 'stop'],
  ]) response.write(`data: ${JSON.stringify({ id: 'runtime-mock', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  response.end('data: [DONE]\n\n')
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const environment = {
  ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  EDICT_USER_DATA_DIR: userData, EDICT_AUTO_DISPATCH: '0', EDICT_SKIP_GATEWAY_RESTART: '1',
}
for (const key of ['OPENCLAW_BIN', 'EDICT_NODE_BIN', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_HOME', 'EDICT_OPENCLAW_HOME', 'EDICT_RUNTIME_DEPENDENCIES']) delete environment[key]
const launch = () => electron.launch({
  ...(process.env.EDICT_SMOKE_APP ? { executablePath: process.env.EDICT_SMOKE_APP, args: [] } : { args: [resolve('.')] }),
  env: environment, timeout: 60000,
})
let app
async function ready() {
  const page = await app.firstWindow()
  await expect.poll(async () => {
    try { return (await page.evaluate(() => window.edictDesktop.getDiagnostics())).startupState }
    catch (error) { if (/Execution context was destroyed/.test(String(error))) return 'navigating'; throw error }
  }, { timeout: 60000 }).toBe('ready')
  return page
}
try {
  app = await launch()
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), expectedVersion)
  let page = await ready()
  const dependencies = await page.evaluate(() => window.edictDesktop.checkRuntime())
  assert(dependencies.ok, JSON.stringify(dependencies.errors))
  const provider = await page.evaluate(({ baseUrl, model, id }) => window.edictDesktop.saveProvider({
    ...(id ? { id } : {}), name: 'Local runtime fixture', baseUrl, apiKey: 'fixture-only', models: [model], defaultModel: model,
  }), { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: MODEL, id: nativeOpenAIProfile ? 'openai' : undefined })
  assert(provider.integration.ok)
  const binding = await page.evaluate(({ providerId, modelId }) => window.edictDesktop.setAgentModel({ agentId: 'taizi', providerId, modelId }), { providerId: provider.id, modelId: MODEL })
  assert(binding.ok, JSON.stringify(binding))
  const firstDiagnostics = await page.evaluate(() => window.edictDesktop.getDiagnostics())
  await expect.poll(async () => {
    const config = JSON.parse(await readFile(firstDiagnostics.openclawConfig, 'utf8'))
    const model = config.agents.list.find(agent => agent.id === 'taizi')?.model
    return typeof model === 'string' ? model : model?.primary
  }, { timeout: 15000 }).toBe(binding.modelReference)
  // Use the real save/resave path; never add capabilities in the test fixture.
  await page.evaluate(provider => window.edictDesktop.saveProvider(provider), {
    id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
    models: [MODEL], defaultModel: MODEL,
  })
  // Provider credentials enter the Python environment only on explicit reload.
  await page.evaluate(() => window.edictDesktop.reloadDashboard()).catch(error => {
    if (!/Execution context was destroyed/.test(String(error))) throw error
  })
  page = await ready()
  const initial = await page.evaluate(() => window.edictDesktop.getDiagnostics())
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await page.getByRole('button', { name: '太子密谈', exact: true }).click()
  await page.getByLabel('议题', { exact: true }).fill('GUI PATH 真实回奏验收')
  await page.getByRole('radio', { name: 'low', exact: true }).check()
  await page.getByRole('button', { name: '召太子入内' }).click()
  await page.getByLabel('皇上发言').fill('请给出简短实施方案')
  const invalid = await page.evaluate(() => window.edictDesktop.saveRuntimePaths({
    openclawPath: '/missing/fixture/openclaw', nodePath: '/missing/fixture/node',
  }))
  assert.equal(invalid.ok, false)
  await page.getByRole('button', { name: '重新检测运行依赖' }).click()
  await expect(page.getByRole('button', { name: '传旨', exact: true })).toBeDisabled()
  const before = await page.evaluate(() => window.edictDesktop.dashboardApi({ method: 'GET', path: '/api/yushufang/rooms' }))
  const roomId = before.rooms[0].roomId
  const rejected = await page.evaluate(roomId => window.edictDesktop.dashboardApi({
    method: 'POST', path: '/api/yushufang/speak', body: { roomId, message: 'must not be consumed' },
  }).catch(error => ({ error: String(error) })), roomId)
  assert(rejected.error)
  const after = await page.evaluate(() => window.edictDesktop.dashboardApi({ method: 'GET', path: '/api/yushufang/rooms' }))
  assert.deepEqual(after.rooms[0].messages, before.rooms[0].messages)
  const restored = await page.evaluate(paths => window.edictDesktop.saveRuntimePaths(paths), {
    openclawPath: dependencies.openclawPath, nodePath: dependencies.nodePath,
  })
  assert(restored.ok, JSON.stringify(restored.errors))
  assert.equal((await page.evaluate(() => window.edictDesktop.getDiagnostics())).dashboardPid, initial.dashboardPid)
  const settingsEvent = app.waitForEvent('window')
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  const settings = await settingsEvent
  await expect(settings.locator('#tab-dependencies')).toBeVisible()
  await expect(settings.locator('#dependencies-status')).toHaveText('已就绪', { timeout: 15000 })
  await expect(settings.getByLabel('OpenClaw 程序路径')).toHaveValue(dependencies.openclawPath)
  await settings.close()
  await page.getByRole('button', { name: '重新检测运行依赖' }).click()
  await expect(page.getByRole('button', { name: '传旨', exact: true })).toBeEnabled()
  await expect(page.getByLabel('皇上发言')).toHaveValue('请给出简短实施方案')
  await page.getByLabel('选择附件', { exact: true }).setInputFiles([{
    name: 'runtime-evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('NATIVE_ATTACHMENT_EVIDENCE_128'),
  }, {
    name: 'runtime-image.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
  }])
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '传旨', exact: true }).click()
  await expect.poll(async () => {
    const phase = await page.locator('.yushu-phase').textContent()
    if (phase.includes('失败')) throw new Error(await page.getByRole('log').innerText())
    return page.locator('.yushu-message.official').count()
  }, { timeout: 90000 }).toBe(1)
  await expect(page.locator('.yushu-message.official')).toContainText('Finder 启动完成真实模型调用')
  await expect(page.locator('.yushu-phase')).toHaveText('待命')
  assert(requests.length > 0)
  assert.equal(requests[0].model, MODEL)
  assert.equal(requests[0].reasoning_effort, 'low')
  assert(JSON.stringify(requests[0].messages).includes('NATIVE_ATTACHMENT_EVIDENCE_128'))
  assert(JSON.stringify(requests).includes('data:image/png;base64,'), 'uploaded image must reach the model')
  for (const [thinking, effort] of [['none', 'none'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ...(nativeOpenAIProfile ? [['max', 'max']] : [])]) {
    const result = await page.evaluate(({ roomId, thinking }) => window.edictDesktop.dashboardApi({
      method: 'POST', path: '/api/yushufang/speak', body: { roomId, message: `验证思考深度 ${thinking}`, thinkingDefault: thinking },
    }), { roomId, thinking })
    assert(result.ok)
    await expect.poll(async () => {
      const result = await page.evaluate(() => window.edictDesktop.dashboardApi({ method: 'GET', path: '/api/yushufang/rooms' }))
      const room = result.rooms.find(room => room.roomId === roomId)
      if (room?.phase === 'failed') throw new Error(JSON.stringify(room.run?.errors || room.messages.slice(-2)))
      return room?.phase
    }, { timeout: 90000 }).toBe('idle')
    assert.equal(requests.at(-1).reasoning_effort, effort, `wire effort for ${thinking}`)
  }
  await expect(page.getByRole('status', { name: '实际思考深度' })).toContainText(nativeOpenAIProfile ? 'max' : 'xhigh')
  const beforeMax = requests.length
  const unsupportedMax = await page.evaluate(input => window.edictDesktop.dashboardApi({
    method: 'POST', path: '/api/yushufang/speak', body: { roomId: input.roomId, message: 'must not be consumed', thinkingDefault: input.level },
  }).catch(error => ({ error: String(error) })), { roomId, level: nativeOpenAIProfile ? 'ultra' : 'max' })
  assert(unsupportedMax.error || unsupportedMax.ok === false, 'unsupported runtime max must fail before dispatch')
  assert.equal(requests.length, beforeMax)
  const policy = await page.evaluate(() => window.edictDesktop.patchAgent({ agentId: 'taizi', patch: { thinkingDefault: 'none' } }))
  assert.equal(policy.code, 0, JSON.stringify(policy))
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: `test-results/packaged-runtime-${nativeOpenAIProfile ? 'openai' : 'custom'}-real-reply.png`, fullPage: true })
  const snapshot = await readFile(join(userData, 'edict', 'runtime-dependencies.json'), 'utf8')
  assert(!snapshot.includes('fixture-only'))
  await app.close()
  // Recreate old missing metadata, then verify upgrade repair and another reply.
  const legacy = JSON.parse(await readFile(firstDiagnostics.openclawConfig, 'utf8'))
  const legacyModel = legacy.models.providers[provider.integration.providerId].models[0]
  delete legacyModel.reasoning
  delete legacyModel.compat
  delete legacyModel.thinkingLevelMap
  delete legacyModel.input
  await writeFile(firstDiagnostics.openclawConfig, JSON.stringify(legacy), { mode: 0o600 })
  app = await launch()
  page = await ready()
  const persisted = await page.evaluate(() => window.edictDesktop.checkRuntime())
  assert(persisted.ok)
  assert.equal(persisted.overrides.openclawPath, dependencies.openclawPath)
  assert.equal(persisted.overrides.nodePath, dependencies.nodePath)
  const rooms = await page.evaluate(() => window.edictDesktop.dashboardApi({ method: 'GET', path: '/api/yushufang/rooms' }))
  assert(rooms.rooms[0].messages.some(message => message.kind === 'agent'))
  const migrated = JSON.parse(await readFile(firstDiagnostics.openclawConfig, 'utf8'))
  assert.equal(migrated.models.providers[provider.integration.providerId].models[0].reasoning, true)
  assert.deepEqual(migrated.models.providers[provider.integration.providerId].models[0].input, ['text', 'image'])
  const continued = await page.evaluate(roomId => window.edictDesktop.dashboardApi({
    method: 'POST', path: '/api/yushufang/speak', body: { roomId, message: '升级后继续回奏', thinkingDefault: 'medium' },
  }), roomId)
  assert(continued.ok)
  await expect.poll(async () => {
    const result = await page.evaluate(() => window.edictDesktop.dashboardApi({ method: 'GET', path: '/api/yushufang/rooms' }))
    return result.rooms.find(room => room.roomId === roomId)?.phase
  }, { timeout: 90000 }).toBe('idle')
  assert.equal(requests.at(-1).reasoning_effort, 'medium')
  assert(JSON.stringify(requests.at(-1).messages).includes('NATIVE_ATTACHMENT_EVIDENCE_128'))
  const capability = await page.evaluate(() => window.edictDesktop.dashboardApi({ path: '/api/model-capabilities' }))
  const modelCapability = capability.models.find(item => item.model === binding.modelReference)
  assert.equal(modelCapability.levels.includes('max'), nativeOpenAIProfile)
  assert(modelCapability.probeLevels.includes('max'))
  assert.equal(capability.agents.find(agent => agent.agentId === 'taizi').thinkingDefault, 'none')
  assert.equal(capability.agents.find(agent => agent.agentId === 'taizi').runtimeThinkingDefault, 'minimal')
  const probes = await page.evaluate(model => window.edictDesktop.probeModelThinking({ model, levels: ['max'], confirmed: true }), binding.modelReference)
  assert.equal(probes.results.max.status, 'accepted')
  assert.equal(requests.at(-1).reasoning_effort, 'max')
  await page.evaluate(() => window.edictDesktop.openModelSettings())
  await expect(page.getByRole('tab', { name: /模型配置/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('radio', { name: 'max', exact: true })).toHaveCount(nativeOpenAIProfile ? 1 : 0)
  if (!nativeOpenAIProfile) await expect(page.getByText(/max.*原生|原生.*max/).first()).toBeVisible()
  await expect(page.getByRole('radio', { name: 'ultra', exact: true })).toHaveCount(0)
  console.log(JSON.stringify({
    passed: true, appVersion: expectedVersion, nativeOpenAIProfile, guiPath: environment.PATH, modelRequests: requests.length,
    hotRepairKeptPythonPid: initial.dashboardPid,
    openclawVersion: persisted.openclawVersion, nodeVersion: persisted.nodeVersion,
    timings: initial.startupTimings,
    efforts: requests.map(request => request.reasoning_effort),
    tests: ['runtime discovery', 'missing paths', 'preflight rejection', 'draft preservation', 'hot repair', 'real provider save/resave', nativeOpenAIProfile ? 'six native thinking levels on wire' : 'five native thinking levels on wire', nativeOpenAIProfile ? 'unsupported ultra rejected without dispatch' : 'runtime max rejected without dispatch', 'attachment content on wire before and after restart', 'uploaded image on wire', 'legacy migration and reply', 'none agent policy restart persistence', 'explicit max API probe with securely injected key', 'direct model settings navigation'],
  }))
} finally {
  if (app) await app.close().catch(() => {})
  await new Promise(resolve => mock.close(resolve))
}
