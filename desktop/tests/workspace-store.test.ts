import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WorkspaceStore } from '../electron/workspace-store.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('WorkspaceStore', () => {
  it('requires a project after selecting a workspace and persists both choices', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'edict-workspace-store-'))
    const workspace = await mkdtemp(join(tmpdir(), 'edict-workspace-'))
    const project = await mkdtemp(join(tmpdir(), 'edict-project-'))
    temporaryDirectories.push(userData, workspace, project)

    const store = new WorkspaceStore(userData)
    const selected = await store.chooseWorkspace(workspace)
    expect(selected.projectPath).toBeNull()
    expect(await store.isReady()).toBe(false)
    expect((await store.checkAccess(workspace)).ok).toBe(true)

    await store.setProject(project)
    expect(await store.isReady()).toBe(true)
    expect((await store.checkAccess(project)).probePassed).toBe(true)
    expect((await store.snapshot()).activeWorkspace?.projectPath).toBe(project)

    const reloaded = new WorkspaceStore(userData)
    const state = await reloaded.snapshot()
    expect(state.activeWorkspace?.path).toBe(workspace)
    expect(state.activeWorkspace?.projectPath).toBe(project)
    expect(JSON.parse(await readFile(join(userData, 'workspaces.json'), 'utf8')).version).toBe(1)
  })

  it('keeps existing desktop runtime data as the first workspace storage root', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'edict-workspace-migration-'))
    const workspace = await mkdtemp(join(tmpdir(), 'edict-workspace-'))
    temporaryDirectories.push(userData, workspace)
    await mkdir(join(userData, 'edict', 'data'), { recursive: true })

    const store = new WorkspaceStore(userData)
    const selected = await store.chooseWorkspace(workspace)
    expect(selected.runtimeRoot).toBe(join(userData, 'edict'))
  })
})
