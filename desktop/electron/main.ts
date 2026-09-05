import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import { ChildProcessByStdio, spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { createServer } from 'node:net'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import {
  ProviderStore,
  testProviderConnection,
  type ProviderDraft,
} from './provider-store.js'
import { ensureRuntimeData, type RuntimeDataPaths } from './runtime-data.js'
import { discoverRuntime, probeRuntime, type RuntimePaths } from '../main/runtime-dependencies.js'
import {
  buildProviderEnvironment,
  configureModelCatalog,
  mergeAgentModelBindings,
  modelReference,
  openClawProviderId,
  readAgentsManifest,
  readOpenClawConfig,
  repairModelCapabilities,
  removeProviderFromOpenClaw,
  setAgentModel,
  syncProviderToOpenClaw,
  writeOpenClawConfig,
} from '../main/integration/openclaw-config.js'
import {
  applyChannelAccountConfig,
  channelSecretRef,
  DESKTOP_CHANNELS,
  getChannelAccountConfig,
  getChannelSpec,
  makeChannelSecretRef,
  normalizeChannelAccountDraft,
  normalizeChannelAccountId,
  normalizeChannelId,
  removeChannelAccountConfig,
  secretInput,
  secretRefId,
  validateRequiredChannelFields,
  type ChannelAccountDraft,
  type ChannelSecretRefs,
  type DesktopChannelId,
} from '../main/integration/channel-config.js'
import {
  createOpenClawConfigStore,
  type AgentPatch,
  type GlobalPatch,
  type McpServerInput,
} from '../main/openclaw-config.js'
import {
  DashboardObservabilityClient,
  summarizeDashboardErrors,
  type DashboardObservabilityOptions,
} from '../main/dashboard-observability.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const development = !app.isPackaged
const isolatedUserData = process.env.EDICT_USER_DATA_DIR || join(app.getPath('appData'), 'EdictDesktop')
const processStartedAt = Date.now()

// Keep this migration build separate from any older Edict desktop bundle.
mkdirSync(isolatedUserData, { recursive: true, mode: 0o700 })
chmodSync(isolatedUserData, 0o700)
// Electron 33 snapshots this name for macOS Keychain before ready. Keep the
// legacy encryption identity; switch only the visible brand after ready.
app.setName('Edict')
app.setPath('userData', isolatedUserData)

type StartupState = 'starting' | 'ready' | 'error' | 'crashed'

type DashboardProcess = ChildProcessByStdio<null, Readable, Readable>

let dashboardProcess: DashboardProcess | undefined
let dashboardUrl = ''
let dashboardWindow: BrowserWindow | undefined
let settingsWindow: BrowserWindow | undefined
let monitorWindow: BrowserWindow | undefined
let providerStore: ProviderStore
let runtimeData: RuntimeDataPaths | undefined
let startupState: StartupState = 'starting'
let startupError = ''
let startupPromise: Promise<void> | undefined
let quitting = false
const startupTimings: {
  processStartedAt: string
  appReadyMs?: number
  runtimeDataMs?: number
  pythonSpawnMs?: number
  healthzMs?: number
  dashboardLoadMs?: number
  completedAt?: string
} = { processStartedAt: new Date(processStartedAt).toISOString() }
let restarting = false
let providerEnvironment: Record<string, string> = {}
let channelEnvironment: Record<string, string> = {}
let dashboardReloadRequired = false
let runtimePaths: RuntimePaths = { openclawPath: '', nodePath: '' }
let runtimeDependencies = discoverConfiguredRuntime()

function bundledRuntimeRoot(): string {
  return development
    ? join(currentDirectory, '..', '..', '..', 'desktop', 'portable-runtime', process.arch)
    : join(process.resourcesPath, 'runtime')
}

function bundledRuntimePath(name: 'openclaw' | 'node'): string {
  return join(bundledRuntimeRoot(), 'bin', name)
}

function bundledPythonPath(): string {
  return join(bundledRuntimeRoot(), 'python', 'bin', 'python3')
}

function preferredRuntimePaths(): RuntimePaths {
  const bundledOpenClaw = bundledRuntimePath('openclaw')
  const bundledNode = bundledRuntimePath('node')
  return {
    openclawPath: runtimePaths.openclawPath || (existsSync(bundledOpenClaw) ? bundledOpenClaw : ''),
    nodePath: runtimePaths.nodePath || (existsSync(bundledNode) ? bundledNode : ''),
  }
}

function discoverConfiguredRuntime() {
  return discoverRuntime(preferredRuntimePaths())
}

function dependenciesPath(): string {
  return join(runtimeDirectory(), 'runtime-dependencies.json')
}

async function refreshRuntimeDependencies(): Promise<void> {
  runtimeDependencies = discoverConfiguredRuntime()
  await mkdir(runtimeDirectory(), { recursive: true, mode: 0o700 })
  const path = dependenciesPath()
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ ...runtimeDependencies, overrides: runtimePaths }), { mode: 0o600 })
  await rename(temporary, path)
}

const AGENT_CONFIG_SYNC_TIMEOUT_MS = 15_000
const AGENT_CONFIG_SYNC_OUTPUT_LIMIT = 2_000

interface AgentConfigSyncResult {
  ok: boolean
  python?: string
  code?: number | null
  signal?: NodeJS.Signals | null
  timedOut?: boolean
  error?: string
}

let lastAgentConfigSync: AgentConfigSyncResult | undefined
let agentConfigSyncQueue: Promise<AgentConfigSyncResult> = Promise.resolve({ ok: true })

interface RuntimeOptions {
  autoDispatch: boolean
  allowGatewayRestart: boolean
}

let runtimeOptions: RuntimeOptions = {
  autoDispatch: process.env.EDICT_AUTO_DISPATCH === '1',
  // Restarting the user's OpenClaw gateway is disruptive and is not needed
  // for persisting a model selection. Make it opt-in from the settings page.
  allowGatewayRestart: process.env.EDICT_SKIP_GATEWAY_RESTART === '0',
}

function effectiveOpenClawHome(): string {
  return process.env.EDICT_OPENCLAW_HOME?.trim() || runtimeData?.openclawHome || join(runtimeDirectory(), 'openclaw')
}

function effectiveOpenClawConfigPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH?.trim() || join(effectiveOpenClawHome(), 'openclaw.json')
}

function openClawConfigStore() {
  return createOpenClawConfigStore({
    configPath: effectiveOpenClawConfigPath(),
    openclawBinary: runtimeDependencies.openclawPath || 'openclaw',
    environment: runtimeEnvironment(upstreamDirectory()),
  })
}

function upstreamDirectory(): string {
  return development ? join(currentDirectory, '..', '..', '..', 'upstream') : join(process.resourcesPath, 'upstream')
}

function settingsDirectory(): string {
  return development ? join(currentDirectory, '..', '..', '..', 'desktop', 'settings') : join(app.getAppPath(), 'settings')
}

function startupDirectory(): string {
  return development ? join(currentDirectory, '..', '..', '..', 'desktop', 'startup') : join(app.getAppPath(), 'startup')
}

function monitorDirectory(): string {
  return development ? join(currentDirectory, '..', '..', '..', 'desktop', 'monitor') : join(app.getAppPath(), 'monitor')
}

function runtimeDirectory(): string {
  return join(app.getPath('userData'), 'edict')
}

function runtimeOptionsPath(): string {
  return join(runtimeDirectory(), 'runtime-options.json')
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

async function loadRuntimeOptions(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(dependenciesPath(), 'utf8'))
    for (const key of ['openclawPath', 'nodePath'] as const) {
      if (typeof saved?.overrides?.[key] === 'string') runtimePaths[key] = saved.overrides[key]
    }
  } catch {}
  await refreshRuntimeDependencies()
  try {
    const raw = await readFile(runtimeOptionsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = parsed as Partial<RuntimeOptions>
      if (typeof value.autoDispatch === 'boolean') runtimeOptions.autoDispatch = value.autoDispatch
      if (typeof value.allowGatewayRestart === 'boolean') runtimeOptions.allowGatewayRestart = value.allowGatewayRestart
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, 'ENOENT')) {
      console.warn(`[edict] runtime options unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  process.env.EDICT_AUTO_DISPATCH = runtimeOptions.autoDispatch ? '1' : '0'
  process.env.EDICT_SKIP_GATEWAY_RESTART = runtimeOptions.allowGatewayRestart ? '0' : '1'
}

async function persistRuntimeOptions(): Promise<void> {
  await mkdir(runtimeDirectory(), { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory(), 0o700)
  await writeFile(runtimeOptionsPath(), `${JSON.stringify(runtimeOptions, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(runtimeOptionsPath(), 0o600)
}

async function persistStartupTimings(): Promise<void> {
  await mkdir(runtimeDirectory(), { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory(), 0o700)
  const path = join(runtimeDirectory(), 'startup-timings.json')
  await writeFile(path, `${JSON.stringify(startupTimings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(path, 0o600)
}

async function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close()
        reject(new Error('Unable to allocate a local dashboard port'))
        return
      }
      const port = address.port
      probe.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

function pythonCandidates(): string[] {
  return [
    process.env.EDICT_PYTHON,
    existsSync(bundledPythonPath()) ? bundledPythonPath() : '',
    'python3.12',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
    'python3',
    '/usr/bin/python3',
  ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index)
}

function markStartup(state: StartupState, error = ''): void {
  startupState = state
  startupError = error
}

function runtimeEnvironment(upstream: string): NodeJS.ProcessEnv {
  const openclawHome = effectiveOpenClawHome()
  return {
    ...process.env,
    ...providerEnvironment,
    ...channelEnvironment,
    PATH: runtimeDependencies.path,
    OPENCLAW_BIN: runtimeDependencies.openclawPath,
    EDICT_NODE_BIN: runtimeDependencies.nodePath,
    EDICT_RUNTIME_DEPENDENCIES: dependenciesPath(),
    EDICT_DESKTOP: '1',
    EDICT_HOME: upstream,
    EDICT_DATA_DIR: runtimeData?.dataDirectory ?? join(runtimeDirectory(), 'data'),
    EDICT_OPENCLAW_HOME: openclawHome,
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_CONFIG_PATH: effectiveOpenClawConfigPath(),
    EDICT_USE_WORKSPACE_DATA: '0',
    EDICT_AUTO_DISPATCH: runtimeOptions.autoDispatch ? '1' : '0',
    // Model changes remain persisted and validated in the isolated desktop
    // config; a gateway restart is opt-in so opening Edict never interrupts a
    // user's unrelated OpenClaw service.
    EDICT_SKIP_GATEWAY_RESTART: runtimeOptions.allowGatewayRestart ? '0' : '1',
    // A failed optional restart must never erase a model selection that was
    // already written to the isolated desktop OpenClaw config.
    EDICT_ROLLBACK_ON_GATEWAY_RESTART_FAILURE: '0',
    PYTHONUNBUFFERED: '1',
  }
}

function redactAgentConfigSyncOutput(value: string, environment: NodeJS.ProcessEnv): string {
  let result = value
  const sensitiveValues = Object.entries(environment)
    .filter(([key, secret]) => /(?:api[-_]?key|access[-_]?token|token|secret|password|authorization|cookie)/i.test(key) && Boolean(secret))
    .map(([, secret]) => secret)
    .filter((secret): secret is string => Boolean(secret))
  for (const secret of sensitiveValues) {
    result = result.split(secret).join('[redacted]')
  }
  return result
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[-_]?key|access[-_]?token|token|secret|password|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AGENT_CONFIG_SYNC_OUTPUT_LIMIT)
}

async function executeAgentConfigSync(): Promise<AgentConfigSyncResult> {
  const upstream = upstreamDirectory()
  const script = join(upstream, 'scripts', 'sync_agent_config.py')
  if (!existsSync(script)) {
    return { ok: false, error: 'EDICT agent 配置同步脚本不存在' }
  }

  const environment = runtimeEnvironment(upstream)
  const failures: string[] = []
  for (const python of pythonCandidates()) {
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined
    try {
      child = spawn(python, [script], {
        cwd: upstream,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data) => {
        stdout += String(data)
        if (stdout.length > AGENT_CONFIG_SYNC_OUTPUT_LIMIT * 2) stdout = stdout.slice(-AGENT_CONFIG_SYNC_OUTPUT_LIMIT * 2)
      })
      child.stderr.on('data', (data) => {
        stderr += String(data)
        if (stderr.length > AGENT_CONFIG_SYNC_OUTPUT_LIMIT * 2) stderr = stderr.slice(-AGENT_CONFIG_SYNC_OUTPUT_LIMIT * 2)
      })

      const result = await new Promise<AgentConfigSyncResult>((resolve) => {
        let settled = false
        let forceKillTimer: NodeJS.Timeout | undefined
        const timeout = setTimeout(() => {
          child?.kill('SIGTERM')
          forceKillTimer = setTimeout(() => child?.kill('SIGKILL'), 500)
          forceKillTimer.unref()
          finish({ ok: false, python, timedOut: true, error: 'EDICT agent 配置同步超时' })
        }, AGENT_CONFIG_SYNC_TIMEOUT_MS)
        timeout.unref()

        const finish = (value: AgentConfigSyncResult) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          if (forceKillTimer) clearTimeout(forceKillTimer)
          resolve(value)
        }

        child?.once('error', (error) => {
          finish({
            ok: false,
            python,
            error: redactAgentConfigSyncOutput(error instanceof Error ? error.message : String(error), environment),
          })
        })
        child?.once('exit', (code, signal) => {
          if (code === 0) {
            finish({ ok: true, python, code, signal })
            return
          }
          const details = redactAgentConfigSyncOutput(stderr || stdout, environment)
          finish({
            ok: false,
            python,
            code,
            signal,
            error: details || `EDICT agent 配置同步失败（code=${code ?? 'null'}）`,
          })
        })
      })
      if (result.ok) return result
      failures.push(result.error || `code=${result.code ?? 'null'}`)
      if (result.timedOut) return result
    } catch (error) {
      failures.push(redactAgentConfigSyncOutput(error instanceof Error ? error.message : String(error), environment))
      if (child && !child.killed) child.kill()
    }
  }

  return {
    ok: false,
    error: failures.length ? `EDICT agent 配置同步失败：${failures.join('; ')}` : 'EDICT agent 配置同步失败',
  }
}

/** Serialize sync runs so a rapid provider edit cannot race the generated data. */
async function syncAgentConfig(): Promise<AgentConfigSyncResult> {
  const run = agentConfigSyncQueue
    .then(executeAgentConfigSync, executeAgentConfigSync)
    .catch((error): AgentConfigSyncResult => ({
      ok: false,
      error: redactAgentConfigSyncOutput(error instanceof Error ? error.message : String(error), runtimeEnvironment(upstreamDirectory())),
    }))
  agentConfigSyncQueue = run
  const result = await run
  lastAgentConfigSync = result
  if (!result.ok) {
    console.warn(`[edict] ${redactAgentConfigSyncOutput(result.error || 'EDICT agent 配置同步失败', runtimeEnvironment(upstreamDirectory()))}`)
  }
  return result
}

async function refreshProviderEnvironment(): Promise<void> {
  try {
    const providers = await providerStore.list()
    providerEnvironment = await buildProviderEnvironment(providers, (id) => providerStore.getSecret(id))
  } catch (error) {
    providerEnvironment = {}
    console.warn(`[edict] provider environment unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

interface OpenClawCommandResult {
  code: number
  stdout: string
  stderr: string
}

interface ChannelAccountSummary {
  channel: DesktopChannelId
  accountId: string
  label: string
  name?: string
  enabled: boolean
  configured: boolean
  pluginInstalled: boolean
  appId?: string
  domain?: string
  secretFields: Record<string, boolean>
}

const CHANNEL_COMMAND_TIMEOUT_MS = 90_000

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function redactedChannelCommandError(value: string): string {
  return redactAgentConfigSyncOutput(value || 'OpenClaw 渠道命令失败', runtimeEnvironment(upstreamDirectory()))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-1_200)
}

async function runOpenClawCommand(args: string[], timeoutMs = CHANNEL_COMMAND_TIMEOUT_MS): Promise<OpenClawCommandResult> {
  const binary = runtimeDependencies.openclawPath || 'openclaw'
  const environment = runtimeEnvironment(upstreamDirectory())
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(binary, args, {
      cwd: upstreamDirectory(),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (result: OpenClawCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ code: 124, stdout, stderr: `${stderr}\nOpenClaw 渠道命令超时` })
    }, timeoutMs)
    timer.unref()
    child.stdout.on('data', (data) => {
      stdout += String(data)
      if (stdout.length > 100_000) stdout = stdout.slice(-100_000)
    })
    child.stderr.on('data', (data) => {
      stderr += String(data)
      if (stderr.length > 100_000) stderr = stderr.slice(-100_000)
    })
    child.once('error', (error) => finish({ code: 1, stdout, stderr: String(error) }))
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }))
  })
}

async function installedChannelMap(): Promise<Record<string, boolean>> {
  const result = await runOpenClawCommand(['channels', 'list', '--all', '--json'], 20_000)
  if (result.code !== 0) return {}
  try {
    const parsed = asObject(JSON.parse(result.stdout))
    const chat = asObject(parsed.chat)
    return Object.fromEntries(Object.entries(chat).map(([id, value]) => [id, asObject(value).installed === true]))
  } catch {
    return {}
  }
}

async function ensureChannelPlugin(channel: DesktopChannelId): Promise<void> {
  const installed = await installedChannelMap()
  if (installed[channel]) return
  const spec = getChannelSpec(channel)
  const result = await runOpenClawCommand(['plugins', 'install', `npm:${spec.npmSpec}`, '--pin'], 120_000)
  if (result.code !== 0) {
    throw new Error(`${spec.label} 渠道组件安装失败：${redactedChannelCommandError(result.stderr || result.stdout)}`)
  }
}

async function channelSecretValue(
  channel: DesktopChannelId,
  accountId: string,
  field: string,
  configuredValue: unknown,
): Promise<string | undefined> {
  const configuredRef = secretRefId(configuredValue)
  if (configuredRef && process.env[configuredRef]?.trim()) return process.env[configuredRef]!.trim()
  const candidates = [channelSecretRef(channel, accountId, field)]
  if (accountId !== 'default') candidates.push(channelSecretRef(channel, 'default', field))
  for (const ref of candidates) {
    const secret = await providerStore.getCredential(ref)
    if (secret?.trim()) return secret.trim()
  }
  if (typeof configuredValue === 'string' && configuredValue.trim()) return configuredValue.trim()
  return undefined
}

async function refreshChannelEnvironment(): Promise<void> {
  const next: Record<string, string> = {}
  try {
    const config = await readOpenClawConfig(effectiveOpenClawConfigPath())
    for (const spec of DESKTOP_CHANNELS) {
      const channel = spec.id as DesktopChannelId
      const section = asObject(asObject(config.channels)[channel])
      const accountIds = new Set<string>(['default'])
      for (const accountId of Object.keys(asObject(section.accounts))) accountIds.add(normalizeChannelAccountId(accountId))
      for (const accountId of accountIds) {
        const account = getChannelAccountConfig(config, channel, accountId)
        for (const field of spec.secretFields) {
          const value = account[field]
          const refId = secretRefId(value)
          if (!refId) continue
          const secret = await channelSecretValue(channel, accountId, field, value)
          if (secret) next[refId] = secret
        }
      }
    }
  } catch (error) {
    console.warn(`[edict] channel environment unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  channelEnvironment = next
}

function channelAccountIds(config: Awaited<ReturnType<typeof readOpenClawConfig>>, channel: DesktopChannelId): string[] {
  const section = asObject(asObject(config.channels)[channel])
  return ['default', ...Object.keys(asObject(section.accounts))]
    .map(normalizeChannelAccountId)
    .filter((value, index, all) => all.indexOf(value) === index)
}

async function listChannelAccounts(): Promise<{ ok: true; channels: ChannelAccountSummary[] }> {
  const config = await readOpenClawConfig(effectiveOpenClawConfigPath())
  const installed = await installedChannelMap()
  const channels: ChannelAccountSummary[] = []
  for (const spec of DESKTOP_CHANNELS) {
    const channel = spec.id as DesktopChannelId
    for (const accountId of channelAccountIds(config, channel)) {
      const account = getChannelAccountConfig(config, channel, accountId)
      const secretFields: Record<string, boolean> = {}
      for (const field of spec.secretFields) {
        secretFields[field] = Boolean(await channelSecretValue(channel, accountId, field, account[field]))
      }
      const configured = spec.requiredFields.every((field) => {
        if (spec.secretFields.includes(field as never)) return secretFields[field]
        return typeof account[field] === 'string' && Boolean(String(account[field]).trim())
      })
      channels.push({
        channel,
        accountId,
        label: spec.label,
        ...(typeof account.name === 'string' && account.name.trim() ? { name: account.name.trim() } : {}),
        enabled: account.enabled !== false,
        configured,
        pluginInstalled: installed[channel] === true,
        ...(typeof account.appId === 'string' ? { appId: account.appId } : {}),
        ...(typeof account.domain === 'string' ? { domain: account.domain } : {}),
        secretFields,
      })
    }
  }
  return { ok: true, channels }
}

async function prepareChannelSecretRefs(
  config: Awaited<ReturnType<typeof readOpenClawConfig>>,
  draft: ChannelAccountDraft,
): Promise<{ refs: ChannelSecretRefs; storedSecrets: Record<string, boolean> }> {
  const accountId = normalizeChannelAccountId(draft.accountId)
  const account = getChannelAccountConfig(config, draft.channel, accountId)
  const refs: ChannelSecretRefs = {}
  const storedSecrets: Record<string, boolean> = {}
  for (const field of getChannelSpec(draft.channel).secretFields) {
    const draftField = draft.channel === 'discord' && field === 'token' ? draft.botToken : draft[field as keyof ChannelAccountDraft] as string | undefined
    const existingValue = secretInput(account, field)
    const secret = draftField?.trim() || await channelSecretValue(draft.channel, accountId, field, existingValue)
    if (!secret) continue
    const ref = makeChannelSecretRef(draft.channel, accountId, field)
    await providerStore.setCredential(channelSecretRef(draft.channel, accountId, field), secret)
    refs[field] = ref
    storedSecrets[field] = true
  }
  return { refs, storedSecrets }
}

async function saveChannelAccount(payload: unknown): Promise<{ ok: true; requiresReload: true; account: ChannelAccountSummary }> {
  const draft = normalizeChannelAccountDraft(payload)
  await ensureChannelPlugin(draft.channel)
  const current = await readOpenClawConfig(effectiveOpenClawConfigPath())
  const accountId = normalizeChannelAccountId(draft.accountId)
  const currentAccount = getChannelAccountConfig(current, draft.channel, accountId)
  const { refs, storedSecrets } = await prepareChannelSecretRefs(current, draft)
  validateRequiredChannelFields(draft, currentAccount, storedSecrets)
  const next = applyChannelAccountConfig(current, draft, refs)
  await writeOpenClawConfig(effectiveOpenClawConfigPath(), next)
  await refreshChannelEnvironment()
  dashboardReloadRequired = true
  const listed = await listChannelAccounts()
  const account = listed.channels.find((entry) => entry.channel === draft.channel && entry.accountId === accountId)
  if (!account) throw new Error('渠道配置已保存，但未能读取保存后的状态')
  return { ok: true, requiresReload: true, account }
}

async function removeChannelAccount(payload: unknown): Promise<{ ok: true; requiresReload: true }> {
  if (!asObject(payload).channel) throw new Error('渠道不能为空')
  const channel = normalizeChannelId(asObject(payload).channel)
  const accountId = normalizeChannelAccountId(asObject(payload).accountId)
  const current = await readOpenClawConfig(effectiveOpenClawConfigPath())
  for (const field of getChannelSpec(channel).secretFields) {
    await providerStore.deleteCredential(channelSecretRef(channel, accountId, field))
  }
  const next = removeChannelAccountConfig(current, channel, accountId)
  await writeOpenClawConfig(effectiveOpenClawConfigPath(), next)
  await refreshChannelEnvironment()
  dashboardReloadRequired = true
  return { ok: true, requiresReload: true }
}

async function probeChannelAccount(payload: unknown): Promise<{ ok: boolean; message: string; raw?: unknown }> {
  const channel = normalizeChannelId(asObject(payload).channel)
  const result = await runOpenClawCommand(['channels', 'status', '--channel', channel, '--probe', '--timeout', '12_000', '--json'], 30_000)
  if (result.code !== 0) return { ok: false, message: redactedChannelCommandError(result.stderr || result.stdout) }
  try {
    const parsed = asObject(JSON.parse(result.stdout))
    const records = Array.isArray(parsed.channels) ? parsed.channels : []
    const accountId = normalizeChannelAccountId(asObject(payload).accountId)
    const match = records.find((entry) => asObject(entry).accountId === accountId)
    const probe = asObject(asObject(match).probe)
    const healthy = match ? asObject(match).configured !== false && asObject(match).enabled !== false && probe.ok !== false : false
    return {
      ok: healthy,
      message: healthy ? '渠道连接检测通过' : '渠道已写入，但 OpenClaw 尚未确认连接，请检查平台权限和账号状态。',
      raw: { configured: asObject(match).configured, enabled: asObject(match).enabled, probe: { ok: probe.ok, status: probe.status } },
    }
  } catch {
    return { ok: true, message: '渠道配置已读取；OpenClaw 未返回结构化检测结果。' }
  }
}

async function stopDashboard(): Promise<void> {
  const child = dashboardProcess
  if (!child) return
  dashboardProcess = undefined
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('exit', finish)
    child.kill()
    setTimeout(finish, 2_000)
  })
}

async function restartDashboard(): Promise<void> {
  restarting = true
  markStartup('starting')
  try {
    await stopDashboard()
    await refreshProviderEnvironment()
    await refreshChannelEnvironment()
    await startDashboard()
    markStartup('ready')
    dashboardReloadRequired = false
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      const loadStartedAt = Date.now()
      await dashboardWindow.loadURL(dashboardUrl)
      startupTimings.dashboardLoadMs = Date.now() - loadStartedAt
      dashboardWindow.show()
    }
    startupTimings.completedAt = new Date().toISOString()
    await persistStartupTimings()
    console.log(`[edict] dashboard reloaded in ${startupTimings.dashboardLoadMs ?? 'n/a'}ms`)
  } finally {
    restarting = false
  }
}

async function startDashboard(): Promise<void> {
  if (dashboardProcess && !dashboardProcess.killed) return

  const upstream = upstreamDirectory()
  const server = join(upstream, 'dashboard', 'server.py')
  if (!existsSync(server)) throw new Error(`EDICT dashboard server is missing: ${server}`)

  const port = await freeLocalPort()
  dashboardUrl = `http://127.0.0.1:${port}`
  const failures: string[] = []

  for (const python of pythonCandidates()) {
    let currentChild: DashboardProcess | undefined
    try {
      const spawnStartedAt = Date.now()
      const child = spawn(python, [server, '--host', '127.0.0.1', '--port', String(port)], {
        cwd: upstream,
        env: runtimeEnvironment(upstream),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      currentChild = child
      dashboardProcess = child
      startupTimings.pythonSpawnMs = Date.now() - spawnStartedAt
      child.stdout.on('data', (data) => console.log(`[edict-dashboard] ${String(data).trimEnd()}`))
      child.stderr.on('data', (data) => console.error(`[edict-dashboard] ${String(data).trimEnd()}`))
      child.once('exit', (code, signal) => {
        if (dashboardProcess !== child) return
        dashboardProcess = undefined
        if (!quitting && !restarting) {
          markStartup('crashed', `EDICT 看板进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`)
          void dialog.showMessageBox({
            type: 'error',
            title: 'EDICT 看板已停止',
            message: '原始 EDICT 看板进程已退出，请打开设置查看诊断信息。',
          })
        }
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 400)
        child.once('spawn', () => {
          clearTimeout(timer)
          resolve()
        })
        child.once('error', reject)
      })
      await waitForDashboard()
      return
    } catch (error) {
      failures.push(`${python}: ${error instanceof Error ? error.message : String(error)}`)
      if (currentChild && !currentChild.killed) currentChild.kill()
      if (dashboardProcess === currentChild) dashboardProcess = undefined
    }
  }
  throw new Error(`Unable to start EDICT dashboard. Tried ${failures.join('; ')}`)
}

async function waitForDashboard(): Promise<void> {
  const healthStartedAt = Date.now()
  const deadline = Date.now() + 20_000
  let lastError = 'not ready'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${dashboardUrl}/healthz`, { signal: AbortSignal.timeout(1_500) })
      if (response.ok) {
        startupTimings.healthzMs = Date.now() - healthStartedAt
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`EDICT dashboard did not become ready: ${lastError}`)
}

async function dashboardRequest(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, timeoutMs = 12_000): Promise<unknown> {
  if (!dashboardUrl) throw new Error('看板尚未启动')
  if (!path.startsWith('/api/') || path.includes('..') || path.includes('://')) {
    throw new Error('看板 API 路径无效')
  }
  const response = await fetch(`${dashboardUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && typeof payload.error === 'string'
      ? payload.error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload
}

async function validateThinking(input: { model?: string; agentId?: string; thinking: string; global?: boolean }): Promise<string> {
  const result = await dashboardRequest('/api/model-capabilities/validate', 'POST', input) as { ok?: boolean; thinking?: string; error?: string }
  if (!result.ok || typeof result.thinking !== 'string') throw new Error(result.error || '模型思考档位验证失败')
  return result.thinking
}

async function requestedThinking(stored: string, model?: string): Promise<string> {
  if (stored === 'off') return 'none'
  if (stored === 'default' || !model) return stored
  const state = await dashboardRequest('/api/model-capabilities', 'GET') as {
    models: Array<{ model: string; levels: string[]; mapping: Record<string, string> }>
  }
  const capability = state.models.find(item => item.model === model)
  if (!capability || capability.levels.includes(stored)) return stored
  return Object.entries(capability.mapping).find(([, runtime]) => runtime === stored)?.[0] ?? stored
}

function diagnostics() {
  return {
    startupState,
    startupError,
    dashboardUrl,
    dashboardPid: dashboardProcess?.pid ?? null,
    dashboardRunning: Boolean(dashboardProcess && !dashboardProcess.killed),
    python: process.env.EDICT_PYTHON || (existsSync(bundledPythonPath()) ? bundledPythonPath() : 'auto'),
    userData: app.getPath('userData'),
    dataDirectory: runtimeData?.dataDirectory ?? null,
    openclawHome: effectiveOpenClawHome(),
    openclawConfig: effectiveOpenClawConfigPath(),
    seededFiles: runtimeData?.seededFiles ?? 0,
    providerEnvironmentCount: Object.keys(providerEnvironment).length,
    channelEnvironmentCount: Object.keys(channelEnvironment).length,
    dashboardReloadRequired,
    gatewayRestartEnabled: runtimeOptions.allowGatewayRestart,
    autoDispatchEnabled: runtimeOptions.autoDispatch,
    runtimeOptions: { ...runtimeOptions },
    runtimeDependencies,
    agentConfigSync: lastAgentConfigSync ?? null,
    startupTimings: { ...startupTimings },
    upstream: upstreamDirectory(),
    settings: settingsDirectory(),
  }
}

function createDashboardWindow(): BrowserWindow {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show()
    dashboardWindow.focus()
    return dashboardWindow
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: 'Edict_InnerCourt · 三省六部总控台',
    backgroundColor: '#080a0f',
    show: false,
    webPreferences: {
      preload: join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  dashboardWindow = window
  void window.loadFile(join(startupDirectory(), 'index.html'))
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (dashboardWindow === window) dashboardWindow = undefined
  })
  return window
}

function createSettingsWindow(tab?: 'dependencies'): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (tab) settingsWindow.webContents.send('settings:tab', tab)
    settingsWindow.focus()
    return settingsWindow
  }
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    title: 'Edict_InnerCourt · 设置',
    backgroundColor: '#07090f',
    parent: dashboardWindow,
    modal: false,
    webPreferences: {
      preload: join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  settingsWindow = window
  if (tab) window.webContents.once('did-finish-load', () => window.webContents.send('settings:tab', tab))
  void window.loadFile(join(settingsDirectory(), 'index.html'))
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = undefined
  })
  return window
}

function createMonitorWindow(): BrowserWindow {
  if (monitorWindow && !monitorWindow.isDestroyed()) {
    monitorWindow.show()
    monitorWindow.focus()
    return monitorWindow
  }
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: 'Edict_InnerCourt · 执行监控',
    backgroundColor: '#0b0f14',
    parent: dashboardWindow,
    modal: false,
    webPreferences: {
      preload: join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  monitorWindow = window
  void window.loadFile(join(monitorDirectory(), 'index.html'))
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (monitorWindow === window) monitorWindow = undefined
  })
  return window
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Edict_InnerCourt',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CommandOrControl+,', click: () => createSettingsWindow() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    // Use the platform edit menu so macOS wires Command+C/V/A to form fields.
    { role: 'editMenu' },
    {
      label: '窗口',
      submenu: [
        { label: '显示总控台', click: () => dashboardWindow?.show() },
        { label: '打开设置', click: () => createSettingsWindow() },
        { label: '打开执行监控', click: () => createMonitorWindow() },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle('dashboard:get-url', () => dashboardUrl)
  ipcMain.handle('dashboard:show', () => {
    dashboardWindow?.show()
    dashboardWindow?.focus()
    return { ok: true }
  })
  ipcMain.handle('settings:show', (_event, tab: unknown) => {
    createSettingsWindow(tab === 'dependencies' ? tab : undefined).show()
    return { ok: true }
  })
  ipcMain.handle('monitor:show', () => {
    createMonitorWindow().show()
    return { ok: true }
  })
  ipcMain.handle('app:diagnostics', () => diagnostics())
  ipcMain.handle('runtime:check', async () => {
    await refreshRuntimeDependencies()
    return { ...await probeRuntime(runtimeDependencies, runtimeEnvironment(upstreamDirectory())), overrides: runtimePaths }
  })
  ipcMain.handle('runtime:select-path', async (_event, kind: unknown) => {
    if (kind !== 'openclawPath' && kind !== 'nodePath') throw new Error('未知程序类型')
    const result = await dialog.showOpenDialog({
      title: kind === 'openclawPath' ? '选择 OpenClaw 程序' : '选择 Node.js 程序',
      properties: ['openFile', 'showHiddenFiles'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('runtime:save-paths', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') throw new Error('运行路径格式无效')
    const next = payload as RuntimePaths
    for (const key of ['openclawPath', 'nodePath'] as const) {
      if (typeof next[key] !== 'string' || next[key].length > 4096 || next[key].includes('\0')) throw new Error('程序路径无效')
      if (next[key].trim() && !next[key].trim().startsWith('/')) throw new Error('请选择程序的绝对路径，留空可自动检测')
    }
    runtimePaths = { openclawPath: next.openclawPath.trim(), nodePath: next.nodePath.trim() }
    await refreshRuntimeDependencies()
    return { ...await probeRuntime(runtimeDependencies, runtimeEnvironment(upstreamDirectory())), overrides: runtimePaths }
  })
  ipcMain.handle('app:retry-dashboard', async () => {
    if (!startupPromise) startupPromise = boot().finally(() => { startupPromise = undefined })
    await startupPromise
    return diagnostics()
  })
  ipcMain.handle('provider:list', () => providerStore.list())
  ipcMain.handle('dashboard:models', () => {
    const window = createDashboardWindow()
    window.show()
    window.focus()
    window.webContents.send('dashboard:models')
  })
  ipcMain.handle('provider:save', async (_event, payload: unknown) => {
    const saved = await providerStore.save(payload as ProviderDraft)
    let integration: Record<string, unknown> = { ok: true, providerId: saved.id }
    try {
      integration = {
        ok: true,
        ...(await syncProviderToOpenClaw(effectiveOpenClawConfigPath(), { ...saved, models: saved.modelDefinitions })),
      }
    } catch (error) {
      integration = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    await refreshProviderEnvironment()
    const agentConfigSync = await syncAgentConfig()
    // Do not restart the original dashboard behind the user's back: a
    // running EDICT task must not be interrupted by a settings save.
    dashboardReloadRequired = true
    return { ...saved, integration, agentConfigSync }
  })
  ipcMain.handle('provider:remove', async (_event, providerId: string) => {
    const removed = await providerStore.remove(providerId)
    let integration = false
    if (removed) integration = await removeProviderFromOpenClaw(effectiveOpenClawConfigPath(), providerId)
    await refreshProviderEnvironment()
    const agentConfigSync = removed ? await syncAgentConfig() : undefined
    if (removed) dashboardReloadRequired = true
    return { ok: removed, openclawRemoved: integration, ...(agentConfigSync ? { agentConfigSync } : {}) }
  })
  ipcMain.handle('provider:test', async (_event, payload: unknown) => {
    const input = payload as ProviderDraft
    const secret = input.apiKey?.trim() || (input.id ? await providerStore.getSecret(input.id) : undefined)
    return testProviderConnection(input, secret)
  })
  ipcMain.handle('provider:probe-thinking', async (_event, payload: unknown) => {
    const input = payload as { model?: string; levels?: string[]; confirmed?: boolean }
    if (!input || typeof input.model !== 'string' || input.confirmed !== true) throw new Error('请确认思考档位检测的调用费用')
    const provider = (await providerStore.list()).find(item => openClawProviderId(item.id) === input.model!.split('/')[0])
    if (!provider || provider.enabled === false) throw new Error('请先保存并启用供应商')
    const secret = await providerStore.getSecret(provider.id)
    if (!secret) throw new Error('供应商密钥未设置')
    // The secret never crosses the renderer bridge or enters persisted evidence.
    return dashboardRequest('/api/model-capabilities/probe', 'POST', {
      model: input.model, levels: input.levels, confirmed: true, _apiKey: secret,
    }, 100_000)
  })
  ipcMain.handle('dashboard:reload', async () => {
    await restartDashboard()
    return diagnostics()
  })
  ipcMain.handle('openclaw:channels-list', () => listChannelAccounts())
  ipcMain.handle('openclaw:channel-save', (_event, payload: unknown) => saveChannelAccount(payload))
  ipcMain.handle('openclaw:channel-remove', (_event, payload: unknown) => removeChannelAccount(payload))
  ipcMain.handle('openclaw:channel-probe', (_event, payload: unknown) => probeChannelAccount(payload))
  ipcMain.handle('app:set-runtime-options', async (_event, payload: unknown) => {
    const input = payload as { autoDispatch?: boolean; allowGatewayRestart?: boolean }
    if (typeof input.autoDispatch === 'boolean') runtimeOptions.autoDispatch = input.autoDispatch
    if (typeof input.allowGatewayRestart === 'boolean') runtimeOptions.allowGatewayRestart = input.allowGatewayRestart
    process.env.EDICT_AUTO_DISPATCH = runtimeOptions.autoDispatch ? '1' : '0'
    process.env.EDICT_SKIP_GATEWAY_RESTART = runtimeOptions.allowGatewayRestart ? '0' : '1'
    await persistRuntimeOptions()
    dashboardReloadRequired = true
    return diagnostics()
  })
  ipcMain.handle('openclaw:snapshot', () => openClawConfigStore().snapshot())
  ipcMain.handle('openclaw:agent-bindings', async () => {
    const manifest = await readAgentsManifest(join(upstreamDirectory(), 'agents.json'))
    const config = await readOpenClawConfig(effectiveOpenClawConfigPath())
    return { ok: true, agents: mergeAgentModelBindings(manifest, config), manifestCount: manifest.length }
  })
  ipcMain.handle('openclaw:set-agent-model', async (_event, payload: unknown) => {
    const input = payload as { agentId?: string; providerId?: string; modelId?: string }
    if (!input.agentId || !input.providerId || !input.modelId) throw new Error('agentId、providerId 和 modelId 均为必填')
    const snapshot = await openClawConfigStore().snapshot()
    const agent = snapshot.agents.find(agent => agent.id === input.agentId)
    const thinking = await requestedThinking(agent?.thinkingDefault ?? snapshot.defaultThinking ?? 'default', agent?.model ?? snapshot.defaultModel)
    await validateThinking({ agentId: input.agentId, model: modelReference(input.providerId, input.modelId), thinking })
    const result = await setAgentModel(dashboardUrl, input.agentId, input.providerId, input.modelId)
    return { ...result, modelReference: modelReference(input.providerId, input.modelId) }
  })
  ipcMain.handle('openclaw:agent-patch', async (_event, payload: unknown) => {
    const input = payload as { agentId?: string; patch?: AgentPatch }
    if (!input.agentId || !input.patch) throw new Error('agentId 和 patch 均为必填')
    if (input.patch.thinkingDefault !== undefined || input.patch.model !== undefined) {
      const snapshot = await openClawConfigStore().snapshot()
      const agent = snapshot.agents.find(item => item.id === input.agentId)
      const requested = input.patch.thinkingDefault === null
        ? await requestedThinking(snapshot.defaultThinking ?? 'default', agent?.model ?? snapshot.defaultModel)
        : input.patch.thinkingDefault ?? await requestedThinking(agent?.thinkingDefault ?? snapshot.defaultThinking ?? 'default', agent?.model ?? snapshot.defaultModel)
      const thinking = await validateThinking({
        agentId: input.agentId,
        model: input.patch.model ?? agent?.model ?? snapshot.defaultModel,
        thinking: requested,
      })
      if (input.patch.thinkingDefault !== undefined && input.patch.thinkingDefault !== null) {
        input.patch.thinkingDefault = thinking === 'default' ? null : thinking as AgentPatch['thinkingDefault']
      } else if (input.patch.model !== undefined && agent?.thinkingDefault !== undefined) {
        input.patch.thinkingDefault = thinking === 'default' ? null : thinking as AgentPatch['thinkingDefault']
      }
    }
    const result = await openClawConfigStore().applyAgentPatch(input.agentId, input.patch)
    // The original dashboard reads its display roster from agent_config.json,
    // while OpenClaw owns the authoritative runtime config. Keep the two
    // views aligned after direct policy edits as well as queued model edits.
    const agentConfigSync = await syncAgentConfig()
    return { ...result, agentConfigSync }
  })
  ipcMain.handle('openclaw:global-patch', async (_event, payload: unknown) => {
    const patch = payload as GlobalPatch
    if (patch.defaultThinking !== undefined || patch.defaultModel !== undefined) {
      const snapshot = await openClawConfigStore().snapshot()
      const thinking = await validateThinking({
        model: patch.defaultModel ?? snapshot.defaultModel,
        thinking: patch.defaultThinking === null ? 'default' : patch.defaultThinking ?? await requestedThinking(snapshot.defaultThinking ?? 'default', snapshot.defaultModel),
        global: true,
      })
      if (patch.defaultThinking !== undefined || snapshot.defaultThinking !== undefined) patch.defaultThinking = thinking === 'default' ? null : thinking as GlobalPatch['defaultThinking']
    }
    const result = await openClawConfigStore().applyGlobalPatch(patch)
    // Global model/thinking changes affect the roster fallback shown by
    // 御书房, so regenerate the dashboard projection before reporting done.
    const agentConfigSync = await syncAgentConfig()
    return { ...result, agentConfigSync }
  })
  ipcMain.handle('openclaw:mcp-upsert', (_event, payload: unknown) => {
    const input = payload as { name?: string; config?: McpServerInput }
    if (!input.name || !input.config) throw new Error('MCP 名称和配置均为必填')
    return openClawConfigStore().upsertMcpServer(input.name, input.config)
  })
  ipcMain.handle('openclaw:mcp-remove', (_event, name: string) => openClawConfigStore().removeMcpServer(name))
  ipcMain.handle('openclaw:mcp-reload', () => openClawConfigStore().reloadMcp())
  ipcMain.handle('openclaw:mcp-probe', (_event, name: string) => openClawConfigStore().probeMcp(name))
  ipcMain.handle('dashboard:api', (_event, payload: unknown) => {
    const input = payload as { path?: string; method?: 'GET' | 'POST'; body?: unknown }
    if (!input.path) throw new Error('看板 API 路径不能为空')
    return dashboardRequest(input.path, input.method ?? 'GET', input.body)
  })
  ipcMain.handle('dashboard:observability', async (_event, options?: unknown) => {
    if (!dashboardUrl) return { checkedAt: new Date().toISOString(), errors: [{ endpoint: 'dashboard', message: '看板尚未启动' }] }
    const snapshot = await new DashboardObservabilityClient({
      baseUrl: dashboardUrl,
      runtime: diagnostics(),
    }).getSnapshot(options as DashboardObservabilityOptions | undefined)
    return { ...snapshot, recentErrors: summarizeDashboardErrors(snapshot) }
  })
}

async function boot(): Promise<void> {
  markStartup('starting')
  try {
    await loadRuntimeOptions()
    const runtimeStartedAt = Date.now()
    runtimeData = await ensureRuntimeData(upstreamDirectory(), runtimeDirectory())
    configureModelCatalog(JSON.parse(await readFile(join(upstreamDirectory(), 'scripts', 'model_capabilities.json'), 'utf8')).models)
    await repairModelCapabilities(effectiveOpenClawConfigPath())
    startupTimings.runtimeDataMs = Date.now() - runtimeStartedAt
    await refreshProviderEnvironment()
    await refreshChannelEnvironment()
    await syncAgentConfig()
    await startDashboard()
    markStartup('ready')
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      const loadStartedAt = Date.now()
      await dashboardWindow.loadURL(dashboardUrl)
      startupTimings.dashboardLoadMs = Date.now() - loadStartedAt
      dashboardWindow.show()
    }
    startupTimings.completedAt = new Date().toISOString()
    await persistStartupTimings()
    console.log(`[edict] startup ready: app=${startupTimings.appReadyMs ?? 'n/a'}ms runtime=${startupTimings.runtimeDataMs ?? 'n/a'}ms python=${startupTimings.pythonSpawnMs ?? 'n/a'}ms healthz=${startupTimings.healthzMs ?? 'n/a'}ms dashboard=${startupTimings.dashboardLoadMs ?? 'n/a'}ms`)
  } catch (error) {
    markStartup('error', error instanceof Error ? error.message : String(error))
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.show()
  }
}

app.whenReady().then(() => {
  app.setName('Edict_InnerCourt')
  startupTimings.appReadyMs = Date.now() - processStartedAt
  providerStore = new ProviderStore(app.getPath('userData'))
  registerIpc()
  buildMenu()
  createDashboardWindow()
  startupPromise = boot().finally(() => { startupPromise = undefined })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDashboardWindow()
      if (startupState !== 'ready' && !startupPromise) {
        startupPromise = boot().finally(() => { startupPromise = undefined })
      }
    }
  })
})

app.on('before-quit', () => {
  quitting = true
  dashboardProcess?.kill()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
