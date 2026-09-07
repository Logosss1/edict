import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const userData = await mkdtemp(join(tmpdir(), 'innercourt-builtins-'))
const workspacePath = await mkdtemp(join(tmpdir(), 'innercourt-builtins-workspace-'))
const executable = process.env.EDICT_SMOKE_APP
const app = await electron.launch({
  ...(executable ? { executablePath: executable, args: [] } : { args: [resolve('.')] }),
  env: { ...process.env, EDICT_USER_DATA_DIR: userData, EDICT_SKIP_GATEWAY_RESTART: '1' },
  timeout: 60_000,
})

try {
  const page = await app.firstWindow()
  await page.evaluate(path => window.edictDesktop.useWorkspacePath(path), workspacePath)
  await page.evaluate(() => window.edictDesktop.useWorkspaceAsProject()).catch(error => {
    if (!/Execution context was destroyed/.test(String(error))) throw error
  })
  await expect.poll(async () => {
    try { return (await page.evaluate(() => window.edictDesktop.getDiagnostics())).startupState }
    catch (error) { if (/Execution context was destroyed/.test(String(error))) return 'navigating'; throw error }
  }, { timeout: 60_000 }).toBe('ready')

  const diagnostics = await page.evaluate(() => window.edictDesktop.getDiagnostics())
  assert.equal(diagnostics.autoDispatchEnabled, true)
  const config = JSON.parse(await readFile(diagnostics.openclawConfig, 'utf8'))
  const servers = config.mcp?.servers || {}
  assert(servers['edict-workspace'], 'workspace MCP was not provisioned')
  assert(servers['edict-memory'], 'memory MCP was not provisioned')
  assert.equal(servers['edict-workspace'].env.EDICT_PROJECT_DIR, workspacePath)
  assert.equal(servers['edict-memory'].env.EDICT_PROJECT_DIR, workspacePath)

  const snapshot = await page.evaluate(() => window.edictDesktop.getOpenClawSnapshot())
  assert(snapshot.mcpServers.some(server => server.name === 'edict-workspace'))
  assert(snapshot.mcpServers.some(server => server.name === 'edict-memory'))
  const skillPaths = [
    'workspace-taizi/skills/edict-triage/SKILL.md',
    'workspace-zhongshu/skills/edict-planning/SKILL.md',
    'workspace-menxia/skills/edict-review/SKILL.md',
    'workspace-bingbu/skills/edict-coding/SKILL.md',
    'workspace-libu/skills/edict-docs/SKILL.md',
  ]
  for (const suffix of skillPaths) {
    const content = await readFile(join(diagnostics.openclawHome, suffix), 'utf8')
    assert(content.includes('---'))
  }
  console.log(JSON.stringify({ passed: true, autoDispatch: diagnostics.autoDispatchEnabled, mcp: Object.keys(servers), skills: skillPaths.length }))
} finally {
  await app.close()
}
