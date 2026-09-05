import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

export interface RuntimePaths {
  openclawPath: string
  nodePath: string
}

export function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch { return false }
}

export function discoverRuntime(
  overrides: Partial<RuntimePaths> = {},
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  systemDirectories = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
) {
  const nvm = join(home, '.nvm', 'versions', 'node')
  let versions: string[] = []
  try { versions = readdirSync(nvm).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 12).map(v => join(nvm, v, 'bin')) } catch {}
  const directories = [...new Set([
    ...(environment.PATH || '').split(delimiter).filter(p => isAbsolute(p)),
    join(home, '.npm-global', 'bin'), join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'), ...systemDirectories, ...versions,
  ])]
  const find = (name: string, configured?: string) => {
    if (configured?.trim()) {
      const value = configured.trim()
      if (isAbsolute(value)) return value
      return directories.map(p => join(p, value)).find(executable) || value
    }
    return directories.map(p => join(p, name)).find(executable) || ''
  }
  const openclawPath = find('openclaw', overrides.openclawPath || environment.OPENCLAW_BIN)
  const nodePath = find('node', overrides.nodePath || environment.EDICT_NODE_BIN)
  const path = [...new Set([nodePath, openclawPath].filter(isAbsolute).map(dirname).concat(directories))].join(delimiter)
  const errors: string[] = []
  if (!isAbsolute(openclawPath) || !executable(openclawPath)) errors.push('未找到可执行的 OpenClaw，请在设置中选择 OpenClaw 程序。')
  if (!isAbsolute(nodePath) || !executable(nodePath)) errors.push('未找到可执行的 Node.js，请在设置中选择 Node 程序。')
  return { ok: errors.length === 0, openclawPath, nodePath, path, errors }
}

export type RuntimeDiscovery = ReturnType<typeof discoverRuntime>

export async function probeRuntime(runtime: RuntimeDiscovery, environment: NodeJS.ProcessEnv) {
  const probe = (file: string): Promise<string | null> => new Promise(resolve => {
    execFile(file, ['--version'], {
      env: { ...environment, PATH: runtime.path }, timeout: 8000, maxBuffer: 8192,
    }, (error, stdout) => {
      // Never expose arbitrary CLI output (which can include config secrets).
      const version = stdout.trim().match(/^(?:OpenClaw\s+)?v?(\d+\.\d+\.\d+(?:[-+.][\w.-]+)?)/i)?.[1]
      resolve(!error && version ? version : null)
    })
  })
  if (!runtime.ok) return { ...runtime, checkedAt: new Date().toISOString() }
  const [openclawVersion, nodeVersion] = await Promise.all([probe(runtime.openclawPath), probe(runtime.nodePath)])
  const errors = [...runtime.errors]
  if (!openclawVersion) errors.push('OpenClaw 版本检测失败或超过 8 秒，请检查所选程序及 Node 版本。')
  if (!nodeVersion) errors.push('Node.js 版本检测失败或超过 8 秒，请检查所选程序。')
  return { ...runtime, ok: errors.length === 0, errors, openclawVersion, nodeVersion, checkedAt: new Date().toISOString() }
}
