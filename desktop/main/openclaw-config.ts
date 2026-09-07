import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import JSON5 from 'json5'

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'adaptive',
  'max',
  'ultra',
] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const TOOL_PROFILES = ['minimal', 'coding', 'messaging', 'full'] as const
export type ToolProfile = (typeof TOOL_PROFILES)[number]

export const SANDBOX_MODES = ['off', 'non-main', 'all'] as const
export type SandboxMode = (typeof SANDBOX_MODES)[number]

export const WORKSPACE_ACCESS = ['none', 'ro', 'rw'] as const
export type WorkspaceAccess = (typeof WORKSPACE_ACCESS)[number]

export type JsonRecord = Record<string, unknown>

export interface AgentToolPolicySummary {
  profile?: ToolProfile
  allow: string[]
  alsoAllow: string[]
  deny: string[]
}

export interface AgentSandboxSummary {
  mode?: SandboxMode
  backend?: string
  workspaceAccess?: WorkspaceAccess
  scope?: 'session' | 'agent' | 'shared'
}

export interface AgentSummary {
  id: string
  name?: string
  description?: string
  workspace?: string
  model?: string
  fallbacks: string[]
  thinkingDefault?: ThinkingLevel
  skills?: string[]
  allowAgents: string[]
  tools: AgentToolPolicySummary
  sandbox: AgentSandboxSummary
}

export interface McpToolFilterSummary {
  include?: string[]
  exclude?: string[]
}

export interface McpServerSummary {
  name: string
  enabled: boolean
  transport?: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  supportsParallelToolCalls?: boolean
  timeout?: number
  connectTimeout?: number
  toolFilter?: McpToolFilterSummary
  codexAgents?: string[]
  codexApproval?: 'auto' | 'prompt' | 'approve'
  hasEnvironment: boolean
  environmentKeys: string[]
  hasHeaders: boolean
  headerNames: string[]
  auth?: 'oauth'
  oauthConfigured: boolean
  sslVerify?: boolean
}

export interface NetworkControlSummary {
  search: {
    path: 'tools.web.search.enabled'
    configured: boolean
    enabled: boolean
  }
  fetch: {
    path: 'tools.web.fetch.enabled'
    configured: boolean
    enabled: boolean
  }
  note: string
}

export interface OpenClawConfigSnapshot {
  path: string
  exists: boolean
  valid: boolean
  defaultModel?: string
  defaultFallbacks: string[]
  defaultThinking?: ThinkingLevel
  defaultToolProfile?: ToolProfile
  agents: AgentSummary[]
  mcpServers: McpServerSummary[]
  network: NetworkControlSummary
  warnings: string[]
}

export interface AgentPatch {
  model?: string | null
  fallbacks?: string[]
  thinkingDefault?: ThinkingLevel | null
  skills?: string[] | null
  allowAgents?: string[] | null
  tools?: Partial<AgentToolPolicySummary> | null
  sandbox?: AgentSandboxSummary | null
}

export interface GlobalPatch {
  defaultModel?: string | null
  defaultFallbacks?: string[]
  defaultThinking?: ThinkingLevel | null
  defaultToolProfile?: ToolProfile | null
  webSearchEnabled?: boolean
  webFetchEnabled?: boolean
}

export interface McpServerInput {
  enabled?: boolean
  command?: string
  args?: string[]
  env?: Record<string, string | number | boolean>
  cwd?: string
  workingDirectory?: string
  url?: string
  transport?: 'stdio' | 'sse' | 'streamable-http'
  headers?: Record<string, string | number | boolean>
  connectionTimeoutMs?: number
  connectTimeout?: number
  requestTimeoutMs?: number
  timeout?: number
  supportsParallelToolCalls?: boolean
  auth?: 'oauth'
  oauth?: {
    scope?: string
    redirectUrl?: string
    clientMetadataUrl?: string
  }
  sslVerify?: boolean
  clientCert?: string
  clientKey?: string
  toolFilter?: McpToolFilterSummary
  codex?: {
    agents?: string[]
    defaultToolsApprovalMode?: 'auto' | 'prompt' | 'approve'
  }
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (args: string[], input?: string) => Promise<CommandResult>

export interface OpenClawConfigStoreOptions {
  configPath?: string
  openclawBinary?: string
  commandRunner?: CommandRunner
  environment?: NodeJS.ProcessEnv
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MCP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const MODEL_PATTERN = /^\S.{0,199}$/
const MCP_ENV_REF_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/
const MCP_SECRET_FIELD_PATTERN = /(api[-_]?key|access[-_]?token|token|secret|password|authorization|cookie|private[-_]?key|client[-_]?secret)/i

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asEnum<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T[number]) : undefined
}

function modelConfig(value: unknown): { primary?: string; fallbacks: string[] } {
  if (typeof value === 'string') return { primary: asString(value), fallbacks: [] }
  const config = asRecord(value)
  return {
    primary: asString(config.primary),
    fallbacks: asStringArray(config.fallbacks),
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function setOrDelete(target: JsonRecord, key: string, value: unknown): void {
  if (value === null || value === undefined) delete target[key]
  else target[key] = value
}

function normalizeAgentId(value: string): string {
  const id = value.trim().toLowerCase()
  if (!AGENT_ID_PATTERN.test(id)) throw new Error('Agent id contains unsupported characters')
  return id
}

function normalizeMcpName(value: string): string {
  const name = value.trim()
  if (!MCP_NAME_PATTERN.test(name)) throw new Error('MCP server name contains unsupported characters')
  return name
}

function normalizeModel(value: string): string {
  const model = value.trim()
  if (!MODEL_PATTERN.test(model)) throw new Error('Model id is required')
  return model
}

function defaultModelSummary(config: JsonRecord): { primary?: string; fallbacks: string[] } {
  const agents = asRecord(config.agents)
  return modelConfig(asRecord(agents.defaults).model)
}

function summarizeAgent(raw: JsonRecord, defaultConfig: { primary?: string; fallbacks: string[] }): AgentSummary | undefined {
  const id = asString(raw.id)
  if (!id || !AGENT_ID_PATTERN.test(id)) return undefined
  const model = modelConfig(raw.model)
  const tools = asRecord(raw.tools)
  const sandbox = asRecord(raw.sandbox)
  const subagents = asRecord(raw.subagents)
  return {
    id,
    name: asString(raw.name),
    description: asString(raw.description),
    workspace: asString(raw.workspace),
    model: model.primary ?? defaultConfig.primary,
    fallbacks: model.fallbacks.length ? model.fallbacks : defaultConfig.fallbacks,
    thinkingDefault: asEnum(raw.thinkingDefault, THINKING_LEVELS),
    skills: Array.isArray(raw.skills) ? asStringArray(raw.skills) : undefined,
    allowAgents: asStringArray(subagents.allowAgents ?? raw.allowAgents),
    tools: {
      profile: asEnum(tools.profile, TOOL_PROFILES),
      allow: asStringArray(tools.allow),
      alsoAllow: asStringArray(tools.alsoAllow),
      deny: asStringArray(tools.deny),
    },
    sandbox: {
      mode: asEnum(sandbox.mode, SANDBOX_MODES),
      backend: asString(sandbox.backend),
      workspaceAccess: asEnum(sandbox.workspaceAccess, WORKSPACE_ACCESS),
      scope: asEnum(sandbox.scope, ['session', 'agent', 'shared'] as const),
    },
  }
}

function summarizeMcpServer(name: string, raw: JsonRecord): McpServerSummary {
  const toolFilter = asRecord(raw.toolFilter)
  const codex = asRecord(raw.codex)
  const env = asRecord(raw.env)
  const headers = asRecord(raw.headers)
  const oauth = asRecord(raw.oauth)
  return {
    name,
    enabled: asBoolean(raw.enabled, true),
    transport: asEnum(raw.transport, ['stdio', 'sse', 'streamable-http'] as const),
    command: asString(raw.command),
    args: Array.isArray(raw.args) ? asStringArray(raw.args) : undefined,
    cwd: asString(raw.cwd ?? raw.workingDirectory),
    url: asString(raw.url),
    supportsParallelToolCalls: typeof raw.supportsParallelToolCalls === 'boolean' ? raw.supportsParallelToolCalls : undefined,
    timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
    connectTimeout: typeof raw.connectTimeout === 'number' ? raw.connectTimeout : undefined,
    toolFilter: Object.keys(toolFilter).length
      ? {
          include: Array.isArray(toolFilter.include) ? asStringArray(toolFilter.include) : undefined,
          exclude: Array.isArray(toolFilter.exclude) ? asStringArray(toolFilter.exclude) : undefined,
        }
      : undefined,
    codexAgents: Array.isArray(codex.agents) ? asStringArray(codex.agents) : undefined,
    codexApproval: asEnum(codex.defaultToolsApprovalMode, ['auto', 'prompt', 'approve'] as const),
    hasEnvironment: Object.keys(env).length > 0,
    environmentKeys: Object.keys(env).sort(),
    hasHeaders: Object.keys(headers).length > 0,
    headerNames: Object.keys(headers).sort(),
    auth: raw.auth === 'oauth' ? 'oauth' : undefined,
    oauthConfigured: Object.keys(oauth).length > 0,
    sslVerify: typeof raw.sslVerify === 'boolean' ? raw.sslVerify : undefined,
  }
}

function summarizeNetwork(config: JsonRecord): NetworkControlSummary {
  const tools = asRecord(config.tools)
  const web = asRecord(tools.web)
  const search = asRecord(web.search)
  const fetch = asRecord(web.fetch)
  return {
    search: {
      path: 'tools.web.search.enabled',
      configured: typeof search.enabled === 'boolean',
      enabled: asBoolean(search.enabled, true),
    },
    fetch: {
      path: 'tools.web.fetch.enabled',
      configured: typeof fetch.enabled === 'boolean',
      enabled: asBoolean(fetch.enabled, true),
    },
    note: 'OpenClaw 没有一个通用 network 开关；联网能力由 web 工具和 Agent 工具策略控制。浏览器网络由 browser/工具策略单独决定。',
  }
}

function validateMcpInput(name: string, input: McpServerInput): void {
  normalizeMcpName(name)
  const transport = input.transport
  const command = asString(input.command)
  const url = asString(input.url)
  if (transport === 'stdio' && !command) throw new Error('stdio MCP server requires command')
  if ((transport === 'sse' || transport === 'streamable-http') && !url) {
    throw new Error('HTTP MCP server requires url')
  }
  if (!transport && url) throw new Error('HTTP MCP server requires transport')
  if (transport && transport !== 'stdio' && command) throw new Error('HTTP MCP server cannot define command')
  if (transport === 'stdio' && url) throw new Error('stdio MCP server cannot define url')
  if (input.command && input.url) throw new Error('MCP server cannot define both command and url')
  validateMcpScalarMap(input.env, 'env')
  validateMcpScalarMap(input.headers, 'headers')
  if (input.toolFilter) {
    for (const values of [input.toolFilter.include, input.toolFilter.exclude]) {
      if (values && (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim()))) {
        throw new Error('MCP tool filters must contain non-empty strings')
      }
    }
  }
}

function validateMcpScalarMap(value: unknown, field: string): void {
  if (value === undefined) return
  if (!isRecord(value)) throw new Error(`MCP ${field} must be an object`)
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) throw new Error(`MCP ${field} contains a blank key`)
    if (!['string', 'number', 'boolean'].includes(typeof entry)) {
      throw new Error(`MCP ${field}.${key} must be a string, number, or boolean`)
    }
    if (MCP_SECRET_FIELD_PATTERN.test(key)) {
      if (typeof entry !== 'string' || !MCP_ENV_REF_PATTERN.test(entry)) {
        throw new Error(`MCP ${field}.${key} must use an \${ENV_VAR} reference; inline secrets are not stored`)
      }
    }
  }
}

function redactError(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .trim()
    .slice(-800)
}

async function defaultCommandRunner(
  binary: string,
  environment: NodeJS.ProcessEnv,
  args: string[],
  input?: string,
): Promise<CommandResult> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary),
      ...(args[0] === 'mcp' && args[1] === 'probe' ? { timeout: 45_000 } : {}),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

export function resolveOpenClawConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.OPENCLAW_CONFIG_PATH?.trim()) return environment.OPENCLAW_CONFIG_PATH.trim()
  const openclawHome = environment.OPENCLAW_HOME?.trim() || join(homedir(), '.openclaw')
  return join(openclawHome, 'openclaw.json')
}

export class OpenClawConfigStore {
  private readonly configPath: string
  private readonly binary: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly runCommand: CommandRunner

  constructor(options: OpenClawConfigStoreOptions = {}) {
    this.configPath = options.configPath ?? resolveOpenClawConfigPath(options.environment)
    this.binary = options.openclawBinary ?? 'openclaw'
    this.environment = { ...process.env, ...options.environment }
    this.runCommand = options.commandRunner ?? ((args, input) => defaultCommandRunner(this.binary, this.environment, args, input))
  }

  get path(): string {
    return this.configPath
  }

  async readRaw(): Promise<{ exists: boolean; config: JsonRecord; warnings: string[] }> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed: unknown = JSON5.parse(raw)
      if (!isRecord(parsed)) return { exists: true, config: {}, warnings: ['openclaw.json 顶层不是对象'] }
      return { exists: true, config: parsed, warnings: [] }
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
      if (code === 'ENOENT') return { exists: false, config: {}, warnings: ['未找到 OpenClaw 配置文件'] }
      return { exists: true, config: {}, warnings: [`读取 OpenClaw 配置失败: ${error instanceof Error ? error.message : String(error)}`] }
    }
  }

  async snapshot(): Promise<OpenClawConfigSnapshot> {
    const loaded = await this.readRaw()
    const defaults = asRecord(asRecord(loaded.config.agents).defaults)
    const defaultModel = modelConfig(defaults.model)
    const rawList = asRecord(loaded.config.agents).list
    const list: unknown[] = Array.isArray(rawList) ? rawList : []
    const agents = list.map((item) => summarizeAgent(asRecord(item), defaultModel)).filter((item): item is AgentSummary => Boolean(item))
    const servers = asRecord(asRecord(loaded.config.mcp).servers)
    const mcpServers = Object.entries(servers).map(([name, server]) => summarizeMcpServer(name, asRecord(server)))
    const defaultThinking = asEnum(defaults.thinkingDefault, THINKING_LEVELS)
    const defaultToolProfile = asEnum(asRecord(loaded.config.tools).profile, TOOL_PROFILES)
    return {
      path: this.configPath,
      exists: loaded.exists,
      valid: loaded.exists && loaded.warnings.length === 0,
      defaultModel: defaultModel.primary,
      defaultFallbacks: defaultModel.fallbacks,
      defaultThinking,
      defaultToolProfile,
      agents,
      mcpServers,
      network: summarizeNetwork(loaded.config),
      warnings: loaded.warnings,
    }
  }

  async applyAgentPatch(agentId: string, patch: AgentPatch): Promise<CommandResult> {
    const id = normalizeAgentId(agentId)
    const loaded = await this.readRaw()
    const agentsConfig = asRecord(loaded.config.agents)
    const agents = Array.isArray(agentsConfig.list) ? agentsConfig.list.map((item) => clone(asRecord(item))) : []
    const index = agents.findIndex((agent) => agent.id === id)
    if (index < 0) throw new Error(`Agent ${id} 不存在于 OpenClaw agents.list`)
    const agent = agents[index]

    if (patch.model !== undefined) {
      if (patch.model === null) delete agent.model
      else agent.model = normalizeModel(patch.model)
    }
    if (patch.fallbacks !== undefined) {
      const fallbacks = patch.fallbacks.map(normalizeModel)
      const current = modelConfig(agent.model)
      if (current.primary) agent.model = { primary: current.primary, fallbacks }
      else if (fallbacks.length) agent.model = { primary: normalizeModel((await this.snapshot()).defaultModel ?? ''), fallbacks }
    }
    if (patch.thinkingDefault !== undefined) {
      if (patch.thinkingDefault !== null && !THINKING_LEVELS.includes(patch.thinkingDefault)) throw new Error('Unsupported thinking level')
      setOrDelete(agent, 'thinkingDefault', patch.thinkingDefault)
    }
    if (patch.skills !== undefined) {
      if (patch.skills === null) delete agent.skills
      else agent.skills = patch.skills.map((skill) => skill.trim()).filter(Boolean)
    }
    if (patch.allowAgents !== undefined) {
      const subagents = asRecord(agent.subagents)
      if (patch.allowAgents === null) delete subagents.allowAgents
      else subagents.allowAgents = patch.allowAgents.map(normalizeAgentId)
      if (Object.keys(subagents).length) agent.subagents = subagents
      else delete agent.subagents
    }
    if (patch.tools !== undefined) {
      if (patch.tools === null) delete agent.tools
      else {
        const tools = asRecord(agent.tools)
        if (patch.tools.profile !== undefined) {
          if (patch.tools.profile !== undefined && patch.tools.profile !== null && !TOOL_PROFILES.includes(patch.tools.profile)) {
            throw new Error('Unsupported tool profile')
          }
          setOrDelete(tools, 'profile', patch.tools.profile)
        }
        for (const key of ['allow', 'alsoAllow', 'deny'] as const) {
          if (patch.tools[key] !== undefined) tools[key] = patch.tools[key]
        }
        if (Object.keys(tools).length) agent.tools = tools
        else delete agent.tools
      }
    }
    if (patch.sandbox !== undefined) {
      if (patch.sandbox === null) delete agent.sandbox
      else {
        const sandbox = asRecord(agent.sandbox)
        for (const key of ['mode', 'backend', 'workspaceAccess', 'scope'] as const) {
          if (patch.sandbox[key] !== undefined) sandbox[key] = patch.sandbox[key]
        }
        agent.sandbox = sandbox
      }
    }
    return this.patch({ agents: { list: agents } })
  }

  async applyGlobalPatch(patch: GlobalPatch): Promise<CommandResult> {
    const next: JsonRecord = {}
    const defaults: JsonRecord = {}
    const model: JsonRecord = {}
    if (patch.defaultModel !== undefined) {
      if (patch.defaultModel === null) defaults.model = null
      else model.primary = normalizeModel(patch.defaultModel)
    }
    if (patch.defaultFallbacks !== undefined) {
      model.fallbacks = patch.defaultFallbacks.map(normalizeModel)
    }
    if (Object.keys(model).length) defaults.model = model
    if (patch.defaultThinking !== undefined) {
      if (patch.defaultThinking !== null && !THINKING_LEVELS.includes(patch.defaultThinking)) throw new Error('Unsupported thinking level')
      defaults.thinkingDefault = patch.defaultThinking
    }
    if (Object.keys(defaults).length) next.agents = { defaults }
    const tools: JsonRecord = {}
    if (patch.defaultToolProfile !== undefined) {
      if (patch.defaultToolProfile !== null && !TOOL_PROFILES.includes(patch.defaultToolProfile)) throw new Error('Unsupported tool profile')
      tools.profile = patch.defaultToolProfile
    }
    const web: JsonRecord = {}
    if (patch.webSearchEnabled !== undefined) web.search = { enabled: patch.webSearchEnabled }
    if (patch.webFetchEnabled !== undefined) web.fetch = { enabled: patch.webFetchEnabled }
    if (Object.keys(web).length) tools.web = web
    if (Object.keys(tools).length) next.tools = tools
    return this.patch(next)
  }

  async upsertMcpServer(name: string, input: McpServerInput): Promise<CommandResult> {
    validateMcpInput(name, input)
    return this.patch({ mcp: { servers: { [normalizeMcpName(name)]: input } } })
  }

  async removeMcpServer(name: string): Promise<CommandResult> {
    return this.patch({ mcp: { servers: { [normalizeMcpName(name)]: null } } })
  }

  async reloadMcp(): Promise<CommandResult> {
    const result = await this.runCommand(['mcp', 'reload'])
    if (result.code !== 0) throw new Error(`MCP reload failed: ${redactError(result.stderr || result.stdout)}`)
    return result
  }

  async probeMcp(name: string) {
    const id = normalizeMcpName(name)
    const started = Date.now()
    const result = await this.runCommand(['mcp', 'probe', id, '--json'])
    if (result.code !== 0) throw new Error('MCP 连接失败，请检查服务地址、启动命令和认证配置。')
    let data: JsonRecord
    try { data = asRecord(JSON.parse(result.stdout)) }
    catch { throw new Error('OpenClaw 未返回有效 MCP 检测结果') }
    const server = asRecord(asRecord(data.servers)[id])
    return {
      connected: Object.keys(server).length > 0,
      latencyMs: Date.now() - started,
      tools: typeof server.tools === 'number' ? server.tools : 0,
      resources: Boolean(server.resources),
      prompts: Boolean(server.prompts),
    }
  }

  private async patch(value: JsonRecord): Promise<CommandResult> {
    const result = await this.runCommand(['config', 'patch', '--stdin'], `${JSON.stringify(value)}\n`)
    if (result.code !== 0) {
      throw new Error(`OpenClaw 配置未应用: ${redactError(result.stderr || result.stdout)}`)
    }
    return result
  }
}

export function createOpenClawConfigStore(options: OpenClawConfigStoreOptions = {}): OpenClawConfigStore {
  return new OpenClawConfigStore({ ...options, configPath: options.configPath ?? resolveOpenClawConfigPath(options.environment) })
}
