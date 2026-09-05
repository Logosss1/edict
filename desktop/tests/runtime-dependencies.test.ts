import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverRuntime, probeRuntime } from '../main/runtime-dependencies.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'edict runtime '))
  roots.push(home)
  const cli = join(home, '.npm-global/bin/openclaw')
  const node = join(home, '.nvm/versions/node/v24.1.0/bin/node')
  for (const path of [cli, node]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '#!/bin/sh\nprintf "v24.1.0\\n"\n', { mode: 0o700 })
  }
  return { home, cli, node }
}

describe('GUI-safe runtime discovery', () => {
  it('discovers user npm + nvm with empty PATH, including spaces', async () => {
    const { home, cli, node } = fixture()
    const result = discoverRuntime({}, { PATH: '' }, home, [])
    expect(result).toMatchObject({ ok: true, openclawPath: cli, nodePath: node })
    expect(result.path.split(':')[0]).toBe(dirname(node))
    expect(await probeRuntime(result, {})).toMatchObject({ ok: true, nodeVersion: '24.1.0' })
  })

  it('does not silently replace an invalid explicit executable', () => {
    const { home, node } = fixture()
    const missing = join(home, 'missing')
    expect(discoverRuntime({ openclawPath: missing }, { PATH: '' }, home, [])).toMatchObject({
      ok: false, openclawPath: missing, nodePath: node,
    })
    writeFileSync(missing, 'not executable', { mode: 0o600 })
    expect(discoverRuntime({ openclawPath: missing }, { PATH: '' }, home, []).ok).toBe(false)
  })

  it('reports missing Node and rejects non-version output without leaking it', async () => {
    const { home, cli, node } = fixture()
    rmSync(node)
    expect(discoverRuntime({}, { PATH: '' }, home, []).errors.join()).toContain('Node.js')
    writeFileSync(node, '#!/bin/sh\nprintf "token=secret-fixture\\n"\n', { mode: 0o700 })
    const result = await probeRuntime(discoverRuntime({ openclawPath: cli }, { PATH: '' }, home, []), {})
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-fixture')
  })

  it('bounds a hung executable probe', async () => {
    const { home, cli } = fixture()
    writeFileSync(cli, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 })
    const started = Date.now()
    const result = await probeRuntime(discoverRuntime({}, { PATH: '' }, home, []), {})
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('8 秒')
    expect(Date.now() - started).toBeLessThan(12000)
  }, 15000)
})
