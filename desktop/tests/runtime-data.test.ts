import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureRuntimeData } from '../electron/runtime-data.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ensureRuntimeData', () => {
  it('seeds the writable data directory only when files are missing', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'edict-runtime-source-'))
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'edict-runtime-user-'))
    temporaryDirectories.push(sourceRoot, runtimeRoot)
    await mkdir(join(sourceRoot, 'docker', 'demo_data'), { recursive: true })
    await mkdir(join(sourceRoot, 'data'), { recursive: true })
    await writeFile(join(sourceRoot, 'docker', 'demo_data', 'tasks_source.json'), '[{"id":"demo"}]')
    await writeFile(join(sourceRoot, 'data', 'schema.json'), '{"version":1}')
    for (const fileName of [
      'agent_config.json',
      'last_model_change_result.json',
      'live_status.json',
      'model_change_log.json',
      'morning_brief.json',
      'officials_stats.json',
      'openclaw.json',
      'pending_model_changes.json',
    ]) {
      await writeFile(join(sourceRoot, 'docker', 'demo_data', fileName), '{}')
    }

    const first = await ensureRuntimeData(sourceRoot, runtimeRoot)
    expect(first.seededFiles).toBe(11)
    expect(await readFile(join(first.dataDirectory, 'tasks_source.json'), 'utf8')).toContain('demo')
    expect(await readFile(join(first.openclawHome, 'openclaw.json'), 'utf8')).toContain('"agents"')

    await writeFile(join(first.dataDirectory, 'tasks_source.json'), '[{"id":"user"}]')
    const second = await ensureRuntimeData(sourceRoot, runtimeRoot)
    expect(second.seededFiles).toBe(0)
    expect(await readFile(join(second.dataDirectory, 'tasks_source.json'), 'utf8')).toContain('user')
  })
})
