import { constants, existsSync } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface WorkspaceProject {
  id: string
  name: string
  path: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceRecord {
  id: string
  name: string
  path: string
  projectPath: string | null
  projects: WorkspaceProject[]
  createdAt: string
  updatedAt: string
  /** Internal app-data location for the isolated EDICT runtime. */
  runtimeRoot: string
}

export interface WorkspaceState {
  activeWorkspaceId: string | null
  activeWorkspace: WorkspaceRecord | null
  workspaces: WorkspaceRecord[]
}

export interface WorkspaceAccessCheck {
  ok: boolean
  path: string
  readable: boolean
  writable: boolean
  traversable: boolean
  probePassed: boolean
  needsSystemPermission?: boolean
  detail: string
}

interface PersistedWorkspaceState {
  version: 1
  activeWorkspaceId: string | null
  workspaces: WorkspaceRecord[]
}

interface NodeErrorLike { code?: string }

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeErrorLike).code === code
}

function cleanPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label}路径无效`)
  const path = resolve(value.trim())
  if (!isAbsolute(path) || path === '/') throw new Error(`${label}路径无效`)
  return path
}

async function ensureDirectory(path: string, create: boolean): Promise<string> {
  const absolute = cleanPath(path, '目录')
  if (create) {
    await mkdir(absolute, { recursive: true, mode: 0o700 })
  }
  const info = await stat(absolute)
  if (!info.isDirectory()) throw new Error('请选择文件夹，而不是文件')
  return absolute
}

async function checkDirectoryAccess(path: string): Promise<WorkspaceAccessCheck> {
  const absolute = cleanPath(path, '目录')
  const result: WorkspaceAccessCheck = {
    ok: false,
    path: absolute,
    readable: false,
    writable: false,
    traversable: false,
    probePassed: false,
    detail: '',
  }
  try {
    const info = await stat(absolute)
    if (!info.isDirectory()) {
      result.detail = '请选择文件夹，而不是文件。'
      return result
    }
    await access(absolute, constants.R_OK | constants.X_OK)
    result.readable = true
    result.traversable = true
    await access(absolute, constants.W_OK)
    result.writable = true
    const probe = join(absolute, `.edict-access-probe-${randomUUID()}.tmp`)
    try {
      await writeFile(probe, 'edict workspace access probe\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      result.probePassed = true
    } finally {
      await unlink(probe).catch(() => undefined)
    }
    result.ok = true
    result.detail = '目录可读、可写，临时文件创建与删除测试通过。'
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
    result.needsSystemPermission = code === 'EACCES' || code === 'EPERM'
    result.detail = result.needsSystemPermission
      ? '应用没有访问此目录的权限；请在 macOS 系统设置中允许文件与文件夹访问。'
      : error instanceof Error ? error.message : '目录权限检查失败。'
  }
  return result
}

function projectName(path: string): string {
  return basename(path) || path
}

function normalizeProject(value: unknown): WorkspaceProject | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkspaceProject>
  if (typeof input.path !== 'string' || !input.path.trim()) return null
  const now = new Date().toISOString()
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    name: typeof input.name === 'string' && input.name ? input.name : projectName(input.path),
    path: resolve(input.path),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
  }
}

function normalizeWorkspace(value: unknown, fallbackRoot: string): WorkspaceRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkspaceRecord>
  if (typeof input.id !== 'string' || !input.id || typeof input.path !== 'string' || !input.path.trim()) return null
  const now = new Date().toISOString()
  const path = resolve(input.path)
  const projects = Array.isArray(input.projects)
    ? input.projects.map(normalizeProject).filter((item): item is WorkspaceProject => Boolean(item))
    : []
  const projectPath = typeof input.projectPath === 'string' && input.projectPath.trim()
    ? resolve(input.projectPath)
    : projects[0]?.path || null
  const runtimeRoot = typeof input.runtimeRoot === 'string' && input.runtimeRoot.trim()
    ? resolve(input.runtimeRoot)
    : join(fallbackRoot, input.id)
  return {
    id: input.id,
    name: typeof input.name === 'string' && input.name ? input.name : projectName(path),
    path,
    projectPath,
    projects,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
    runtimeRoot,
  }
}

/**
 * Stores workspace identity in app data while keeping each workspace's EDICT
 * runtime in its own private app-data directory. The selected project path is
 * user-owned and is never copied or deleted by this store.
 */
export class WorkspaceStore {
  private readonly statePath: string
  private readonly runtimeRoot: string
  private state: PersistedWorkspaceState = { version: 1, activeWorkspaceId: null, workspaces: [] }
  private loaded = false
  private loading: Promise<void> | undefined

  constructor(private readonly userData: string) {
    this.statePath = join(userData, 'workspaces.json')
    this.runtimeRoot = join(userData, 'edict', 'workspaces')
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedWorkspaceState>
        const workspaces = Array.isArray(raw.workspaces)
          ? raw.workspaces.map((item) => normalizeWorkspace(item, this.runtimeRoot)).filter((item): item is WorkspaceRecord => Boolean(item))
          : []
        const activeWorkspaceId = typeof raw.activeWorkspaceId === 'string' && workspaces.some((item) => item.id === raw.activeWorkspaceId)
          ? raw.activeWorkspaceId
          : null
        this.state = { version: 1, activeWorkspaceId, workspaces }
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) console.warn(`[edict] workspace registry unavailable: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.loaded = true
        this.loading = undefined
      }
    })()
    return this.loading
  }

  private async persist(): Promise<void> {
    await mkdir(this.userData, { recursive: true, mode: 0o700 })
    await chmod(this.userData, 0o700)
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.statePath)
    await chmod(this.statePath, 0o600)
  }

  async snapshot(): Promise<WorkspaceState> {
    await this.load()
    const activeWorkspace = this.state.workspaces.find((item) => item.id === this.state.activeWorkspaceId) || null
    return {
      activeWorkspaceId: this.state.activeWorkspaceId,
      activeWorkspace,
      workspaces: [...this.state.workspaces],
    }
  }

  async getActive(): Promise<WorkspaceRecord | null> {
    const state = await this.snapshot()
    return state.activeWorkspace
  }

  async isReady(): Promise<boolean> {
    const active = await this.getActive()
    return Boolean(active?.projectPath)
  }

  async checkAccess(path: string): Promise<WorkspaceAccessCheck> {
    return checkDirectoryAccess(path)
  }

  async chooseWorkspace(path: string, create = false): Promise<WorkspaceRecord> {
    await this.load()
    const absolute = await ensureDirectory(path, create)
    const accessCheck = await checkDirectoryAccess(absolute)
    if (!accessCheck.ok) throw new Error(accessCheck.detail)
    const existing = this.state.workspaces.find((item) => item.path === absolute)
    const now = new Date().toISOString()
    if (existing) {
      existing.updatedAt = now
      this.state.activeWorkspaceId = existing.id
      await this.persist()
      return existing
    }

    const legacyRoot = join(this.userData, 'edict')
    const hasLegacyRuntime = existsSync(join(legacyRoot, 'data')) || existsSync(join(legacyRoot, 'openclaw'))
    const id = randomUUID()
    const record: WorkspaceRecord = {
      id,
      name: projectName(absolute),
      path: absolute,
      projectPath: null,
      projects: [],
      createdAt: now,
      updatedAt: now,
      // Keep an existing installation's task history on the first explicit
      // workspace selection. New workspaces are isolated below workspaces/.
      runtimeRoot: this.state.workspaces.length === 0 && hasLegacyRuntime
        ? legacyRoot
        : join(this.runtimeRoot, id),
    }
    this.state.workspaces.push(record)
    this.state.activeWorkspaceId = record.id
    await this.persist()
    return record
  }

  async activate(id: string): Promise<WorkspaceRecord> {
    await this.load()
    const record = this.state.workspaces.find((item) => item.id === id)
    if (!record) throw new Error('工作区不存在')
    this.state.activeWorkspaceId = record.id
    record.updatedAt = new Date().toISOString()
    await this.persist()
    return record
  }

  async setProject(path: string): Promise<WorkspaceRecord> {
    await this.load()
    const active = this.state.workspaces.find((item) => item.id === this.state.activeWorkspaceId)
    if (!active) throw new Error('请先选择工作区')
    const absolute = await ensureDirectory(path, false)
    const accessCheck = await checkDirectoryAccess(absolute)
    if (!accessCheck.ok) throw new Error(accessCheck.detail)
    const now = new Date().toISOString()
    const existing = active.projects.find((item) => item.path === absolute)
    if (existing) {
      existing.updatedAt = now
      active.projectPath = existing.path
    } else {
      const project: WorkspaceProject = {
        id: randomUUID(),
        name: projectName(absolute),
        path: absolute,
        createdAt: now,
        updatedAt: now,
      }
      active.projects.unshift(project)
      active.projectPath = project.path
    }
    active.updatedAt = now
    await this.persist()
    return active
  }

  async useWorkspaceAsProject(): Promise<WorkspaceRecord> {
    const active = await this.getActive()
    if (!active) throw new Error('请先选择工作区')
    return this.setProject(active.path)
  }
}
