import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEMO_DATA_FILES = [
  'agent_config.json',
  'last_model_change_result.json',
  'live_status.json',
  'model_change_log.json',
  'morning_brief.json',
  'officials_stats.json',
  'openclaw.json',
  'pending_model_changes.json',
  'tasks_source.json',
] as const

const AGENT_WORK_PROTOCOL = `# AGENTS.md · 工作协议

1. 接到任务先回复“已接旨”。
2. 输出必须包含：任务ID、结果、证据/文件路径、阻塞项。
3. 需要协作时，回复尚书省请求转派，不跨部直连。
4. 涉及删除/外发动作必须明确标注并等待批准。
`

interface NodeErrorLike {
  code?: string
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeErrorLike).code === code
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

async function copyIfMissing(source: string, destination: string): Promise<boolean> {
  try {
    await access(destination)
    return false
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  await copyFile(source, destination)
  await chmod(destination, 0o600)
  return true
}

export interface RuntimeDataPaths {
  rootDirectory: string
  dataDirectory: string
  openclawHome: string
  openclawConfigPath: string
  seededFiles: number
}

async function seedOpenClawHome(sourceRoot: string, rootDirectory: string): Promise<{ home: string; configPath: string; seeded: boolean }> {
  const home = join(rootDirectory, 'openclaw')
  const configPath = join(home, 'openclaw.json')
  await secureDirectory(home)

  let seeded = false
  try {
    await access(configPath)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    const source = join(sourceRoot, 'docker', 'demo_data', 'openclaw.json')
    const raw = await readFile(source, 'utf8')
    const config = JSON.parse(raw) as Record<string, any>
    const agents = config.agents && typeof config.agents === 'object' ? config.agents : {}
    const defaults = agents.defaults && typeof agents.defaults === 'object' ? agents.defaults : {}
    defaults.workspace = join(home, 'workspace')
    agents.defaults = defaults
    if (Array.isArray(agents.list)) {
      agents.list = agents.list.map((agent: unknown) => {
        if (!agent || typeof agent !== 'object') return agent
        const record = agent as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id : ''
        return {
          ...record,
          ...(id ? { workspace: join(home, `workspace-${id}`), agentDir: join(home, 'agents', id, 'agent') } : {}),
        }
      })
    }
    config.agents = agents
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(configPath, 0o600)
    seeded = true
  }
  return { home, configPath, seeded }
}

/**
 * Apply the parts of the upstream install script that are runtime defaults,
 * not user choices. Existing workspace instructions are never overwritten.
 */
async function ensureDesktopOpenClawDefaults(home: string, configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
  const tools = config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools) ? config.tools : {}
  const sessions = tools.sessions && typeof tools.sessions === 'object' && !Array.isArray(tools.sessions) ? tools.sessions : {}
  let configChanged = false

  if (sessions.visibility !== 'all') {
    sessions.visibility = 'all'
    tools.sessions = sessions
    config.tools = tools
    configChanged = true
  }

  const agents = config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents) ? config.agents : {}
  const list = Array.isArray(agents.list) ? agents.list : []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim()) continue
    const workspace = typeof entry.workspace === 'string' && entry.workspace.trim()
      ? entry.workspace.trim()
      : join(home, `workspace-${entry.id.trim()}`)
    await secureDirectory(workspace)
    const protocolPath = join(workspace, 'AGENTS.md')
    try {
      await access(protocolPath)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      await writeFile(protocolPath, AGENT_WORK_PROTOCOL, { encoding: 'utf8', mode: 0o600 })
      await chmod(protocolPath, 0o600)
    }
  }

  if (configChanged) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(configPath, 0o600)
  }
}

/**
 * Creates a writable per-install data directory without copying the source
 * tree. Demo data is only a first-run fallback; existing user data wins.
 */
export async function ensureRuntimeData(sourceRoot: string, rootDirectory: string): Promise<RuntimeDataPaths> {
  const dataDirectory = join(rootDirectory, 'data')
  await secureDirectory(rootDirectory)
  await secureDirectory(dataDirectory)

  const openclaw = await seedOpenClawHome(sourceRoot, rootDirectory)
  await ensureDesktopOpenClawDefaults(openclaw.home, openclaw.configPath)

  let seededFiles = 0
  const demoDirectory = join(sourceRoot, 'docker', 'demo_data')
  for (const fileName of DEMO_DATA_FILES) {
    if (await copyIfMissing(join(demoDirectory, fileName), join(dataDirectory, fileName))) {
      seededFiles += 1
    }
  }

  const schemaDestination = join(dataDirectory, 'schema.json')
  if (await copyIfMissing(join(sourceRoot, 'data', 'schema.json'), schemaDestination)) {
    seededFiles += 1
  }

  return {
    rootDirectory,
    dataDirectory,
    openclawHome: openclaw.home,
    openclawConfigPath: openclaw.configPath,
    seededFiles: seededFiles + (openclaw.seeded ? 1 : 0),
  }
}
