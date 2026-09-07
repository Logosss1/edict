import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const userData = await mkdtemp(join(tmpdir(), 'innercourt-smoke-'))
const workspacePath = await mkdtemp(join(tmpdir(), 'innercourt-workspace-'))
const launch = (executable = process.env.EDICT_SMOKE_APP) => electron.launch({
  ...(executable ? { executablePath: executable, args: [] } : { args: [resolve('.')] }),
  env: { ...process.env, EDICT_USER_DATA_DIR: userData, EDICT_AUTO_DISPATCH: '0', EDICT_SKIP_GATEWAY_RESTART: '1' },
  timeout: 60000,
})
let legacyCipher
if (process.env.EDICT_SMOKE_OLD_APP) {
  const legacy = await launch(process.env.EDICT_SMOKE_OLD_APP)
  try {
    await legacy.firstWindow()
    legacyCipher = await legacy.evaluate(({ safeStorage }) => safeStorage.encryptString('fixture-upgrade').toString('base64'))
  } finally { await legacy.close() }
}
let app = await launch()
let clipboardSnapshot
const restoreClipboard = () => app.evaluate(({ clipboard }, snapshot) => {
  clipboard.clear()
  for (const [format, value] of snapshot) clipboard.writeBuffer(format, Buffer.from(value, 'base64'))
}, clipboardSnapshot)
try {
  const dashboard = await app.firstWindow()
  await dashboard.evaluate(path => window.edictDesktop.useWorkspacePath(path), workspacePath)
  await dashboard.evaluate(() => window.edictDesktop.useWorkspaceAsProject()).catch(error => {
    if (!/Execution context was destroyed/.test(String(error))) throw error
  })
  await expect.poll(async () => {
    try {
      const status = await dashboard.evaluate(() => window.edictDesktop.getDiagnostics())
      if (status.startupState === 'error') throw new Error(status.startupError)
      return status.startupState
    } catch (error) {
      if (/Execution context was destroyed/.test(String(error))) return 'navigating'
      throw error
    }
  }, { timeout: 60000 }).toBe('ready')
  assert.equal(await app.evaluate(({ app }) => app.getName()), 'Edict_InnerCourt')
  if (legacyCipher) {
    assert.equal(await app.evaluate(({ safeStorage }, value) => safeStorage.decryptString(Buffer.from(value, 'base64')), legacyCipher), 'fixture-upgrade')
    console.log('PASS: legacy Edict secure-storage identity survives the rename')
  }
  const diagnostics = await dashboard.evaluate(() => window.edictDesktop.getDiagnostics())
  console.log(JSON.stringify({ startupState: diagnostics.startupState, startupError: diagnostics.startupError, timings: diagnostics.startupTimings }))
  assert.equal(diagnostics.startupState, 'ready', diagnostics.startupError)
  await dashboard.getByRole('tab', { name: '御书房', exact: true }).click()
  assert(await dashboard.getByRole('checkbox').count() > 0)
  const settingsEvent = app.waitForEvent('window')
  await dashboard.evaluate(() => window.edictDesktop.openSettings())
  const settings = await settingsEvent
  await settings.waitForLoadState()
  assert.equal(await settings.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(7, 9, 15)')
  clipboardSnapshot = await app.evaluate(({ clipboard }) => clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format).toString('base64')]))
  await app.evaluate(({ clipboard }) => clipboard.writeText('https://fixture.example/v1'))
  await settings.locator('#provider-url').focus()
  await settings.keyboard.press('Meta+V')
  assert.equal(await settings.locator('#provider-url').inputValue(), 'https://fixture.example/v1')
  await app.evaluate(({ clipboard }) => clipboard.writeText('fixture-paste-only'))
  await settings.locator('#provider-key').focus()
  await settings.keyboard.press('Meta+V')
  assert.equal(await settings.locator('#provider-key').inputValue(), 'fixture-paste-only')
  await restoreClipboard()
  clipboardSnapshot = undefined
  const cipher = await app.evaluate(({ safeStorage }) => safeStorage.encryptString('fixture-roundtrip').toString('base64'))
  await app.close()
  app = await launch()
  await app.firstWindow()
  assert.equal(await app.evaluate(({ safeStorage }, value) => safeStorage.decryptString(Buffer.from(value, 'base64')), cipher), 'fixture-roundtrip')
  console.log('PASS: app brand, first screen, roster, settings theme, native paste, secure-storage restart')
} finally {
  if (clipboardSnapshot !== undefined) await restoreClipboard().catch(() => {})
  await app.close()
}
