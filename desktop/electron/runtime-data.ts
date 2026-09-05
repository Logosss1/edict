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
 * Creates a writable per-install data directory without copying the source
 * tree. Demo data is only a first-run fallback; existing user data wins.
 */
export async function ensureRuntimeData(sourceRoot: string, rootDirectory: string): Promise<RuntimeDataPaths> {
  const dataDirectory = join(rootDirectory, 'data')
  await secureDirectory(rootDirectory)
  await secureDirectory(dataDirectory)

  const openclaw = await seedOpenClawHome(sourceRoot, rootDirectory)

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
