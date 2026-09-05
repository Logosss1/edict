import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import type { ProviderModelInput } from '../providers/types.js'

/** The subset of an OpenClaw provider config that EDICT owns. */
export interface OpenClawSecretRef {
  source: 'env'
  provider: 'default'
  id: string
}

export interface OpenClawModelDefinition {
  id: string
  name: string
  contextWindow?: number
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
  compat?: {
    supportsReasoningEffort?: boolean
    supportedReasoningEfforts?: string[]
    reasoningEffortMap?: Record<string, string | null>
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface OpenClawProviderConfig {
  baseUrl: string
  api: 'openai-completions'
  auth: 'api-key'
  apiKey?: OpenClawSecretRef
  models: OpenClawModelDefinition[]
  [key: string]: unknown
}

export interface OpenClawConfig {
  agents?: {
    defaults?: {
      model?: string | { primary?: string; fallbacks?: string[] }
      models?: Record<string, unknown>
      [key: string]: unknown
    }
    list?: Array<Record<string, unknown>>
    [key: string]: unknown
  }
  models?: {
    mode?: 'merge' | 'replace' | string
    providers?: Record<string, OpenClawProviderConfig>
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface EdictAgentManifestEntry {
  id: string
  name: string
  workspace?: string
  agentDir?: string
  subagents: { allowAgents: string[] }
}

export interface AgentModelBinding {
  agentId: string
  label?: string
  model?: string
  defaultModel?: string
  providerId?: string
  modelId?: string
  workspace?: string
}

export interface EdictProviderInput {
  id: string
  name?: string
  baseUrl: string
  models?: Array<string | ProviderModelInput>
  enabled?: boolean
  hasApiKey?: boolean
  /** Alias used by the Electron settings facade. */
  secretStored?: boolean
}

export type IntegrationFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

export interface EdictApiOptions {
  fetch?: IntegrationFetch
  timeoutMs?: number
}

export interface SetAgentModelResult {
  ok: boolean
  agentId?: string
  model?: string
  message?: string
  error?: string
  [key: string]: unknown
}

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const OPENCLAW_PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/
const MODEL_ID_MAX_LENGTH = 200
const ENV_PREFIX = 'EDICT_PROVIDER_'
// Some OpenAI-compatible gateways reject the OpenAI SDK's default
// `OpenAI/JS <version>` user agent before inspecting the request body. Keep a
// stable, non-sensitive application identifier on EDICT-managed requests.
export const EDICT_PROVIDER_USER_AGENT = 'Edict_InnerCourt'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message)
}

function normalizeText(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw new Error(`${field} is invalid`)
  return normalized
}

function normalizeAgentId(value: unknown): string {
  const id = normalizeText(value, 'agentId', 64)
  if (!AGENT_ID_PATTERN.test(id)) throw new Error('agentId contains unsupported characters')
  return id
}

/**
 * Convert a ProviderStore id to the provider-id grammar used by OpenClaw.
 * The conversion is deterministic so model refs remain stable between runs.
 */
export function openClawProviderId(value: string): string {
  const raw = normalizeText(value, 'providerId', 120).toLowerCase()
  let id = raw.replace(/[^a-z0-9_-]+/g, '-')
  id = id.replace(/^-+|-+$/g, '')
  if (!id) id = 'provider'
  if (!/^[a-z]/.test(id)) id = `edict-${id}`
  id = id.slice(0, 63).replace(/[-_]+$/g, '')
  if (!OPENCLAW_PROVIDER_PATTERN.test(id)) throw new Error('providerId cannot be represented in OpenClaw')
  return id
}

export function providerApiKeyEnvVar(providerId: string): string {
  const normalized = openClawProviderId(providerId).toUpperCase()
  return `${ENV_PREFIX}${normalized.replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Normalize an OpenAI-compatible API root for OpenClaw's provider adapter.
 *
 * OpenClaw appends `/chat/completions` to `baseUrl`. Most gateways expose
 * that route below `/v1`, while settings forms commonly accept the host-only
 * URL. Preserve an explicit custom path so gateways such as `/api/v1` keep
 * working, and never append `/v1` twice.
 */
export function normalizeOpenAIBaseUrl(value: string): string {
  const normalized = normalizeText(value, 'baseUrl', 2_000).replace(/\/+$/, '')
  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return normalized
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/v1'
      return parsed.toString().replace(/\/$/, '')
    }
  } catch {
    // The caller's existing URL validation owns the final error message. Keep
    // malformed legacy values unchanged here rather than masking it.
  }
  return normalized
}

export function modelReference(providerId: string, modelId: string): string {
  const normalizedModel = normalizeText(modelId, 'modelId', MODEL_ID_MAX_LENGTH)
  return `${openClawProviderId(providerId)}/${normalizedModel}`
}

let knownModelCatalog: Record<string, Partial<OpenClawModelDefinition>> = {}

export function configureModelCatalog(catalog: Record<string, Partial<OpenClawModelDefinition>>): void {
  knownModelCatalog = catalog
}

function withKnownModelCapabilities(model: OpenClawModelDefinition): OpenClawModelDefinition {
  const known = knownModelCatalog[model.id]
  if (!known) return model
  const capable = { ...known, ...model }
  if (model.reasoning === false) return capable
  const efforts = model.compat?.supportedReasoningEfforts ?? known.compat?.supportedReasoningEfforts ?? []
  const defaults = { ...known.compat?.reasoningEffortMap }
  if (efforts.includes('minimal') || !efforts.includes('none')) delete defaults.minimal
  const compat = { ...known.compat, ...model.compat }
  delete compat.reasoningEffortMap
  if (Object.keys(defaults).length || model.compat?.reasoningEffortMap) {
    compat.reasoningEffortMap = { ...defaults, ...model.compat?.reasoningEffortMap }
  }
  return {
    ...capable,
    thinkingLevelMap: { ...known.thinkingLevelMap, ...model.thinkingLevelMap },
    compat,
  }
}

export async function repairModelCapabilities(filePath: string): Promise<boolean> {
  const config = await readOpenClawConfig(filePath)
  let changed = false
  for (const provider of Object.values(config.models?.providers ?? {})) {
    if ((provider.api === undefined || provider.api === 'openai-completions') && typeof provider.baseUrl === 'string') {
      const normalizedBaseUrl = normalizeOpenAIBaseUrl(provider.baseUrl)
      if (normalizedBaseUrl !== provider.baseUrl) {
        provider.baseUrl = normalizedBaseUrl
        changed = true
      }
    }
    if (!Array.isArray(provider.models)) continue
    provider.models = provider.models.map(model => {
      const next = withKnownModelCapabilities(model)
      if (JSON.stringify(next) !== JSON.stringify(model)) changed = true
      return next
    })
  }
  if (changed) await writeOpenClawConfig(filePath, config)
  return changed
}

function normalizeModelDefinitions(
  models: EdictProviderInput['models'],
  existingModels: unknown,
): OpenClawModelDefinition[] {
  const previous = new Map<string, OpenClawModelDefinition>()
  if (Array.isArray(existingModels)) {
    for (const item of existingModels) {
      if (!isRecord(item) || typeof item.id !== 'string') continue
      const id = item.id.trim()
      if (!id) continue
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id
      const contextWindow = item.contextWindow
      previous.set(id, { ...item, id, name, ...(contextWindow === undefined ? {} : { contextWindow: Number(contextWindow) }) })
    }
  }

  const result: OpenClawModelDefinition[] = []
  const seen = new Set<string>()
  for (const entry of models ?? []) {
    const candidate = typeof entry === 'string' ? { id: entry } : entry
    if (!candidate || typeof candidate.id !== 'string') continue
    const id = normalizeText(candidate.id, 'modelId', MODEL_ID_MAX_LENGTH)
    if (seen.has(id)) continue
    seen.add(id)
    const old = previous.get(id)
    const label = typeof candidate.label === 'string' && candidate.label.trim()
      ? candidate.label.trim()
      : old?.name ?? id
    const contextWindow = candidate.contextWindow ?? old?.contextWindow
    result.push(withKnownModelCapabilities({
      ...old, id, name: label,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(candidate.reasoning === undefined ? {} : { reasoning: candidate.reasoning }),
      ...(candidate.supportedReasoningEfforts === undefined ? {} : {
        compat: { ...old?.compat, supportsReasoningEffort: true, supportedReasoningEfforts: candidate.supportedReasoningEfforts },
      }),
    }))
  }
  return result
}

function cloneConfig(config: OpenClawConfig): OpenClawConfig {
  return JSON.parse(JSON.stringify(config)) as OpenClawConfig
}

/** Read a strict JSON OpenClaw config without logging its contents. */
export async function readOpenClawConfig(filePath: string): Promise<OpenClawConfig> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {}
    throw new Error(`Unable to read OpenClaw config: ${filePath}`)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    assertObject(parsed, 'OpenClaw config must be a JSON object')
    return parsed as OpenClawConfig
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('OpenClaw config is not valid JSON')
    throw error
  }
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

/** Atomically write an OpenClaw config while preserving restrictive permissions. */
export async function writeOpenClawConfig(filePath: string, config: OpenClawConfig): Promise<void> {
  const directory = dirname(filePath)
  await secureDirectory(directory)
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
  } catch {
    throw new Error(`Unable to write OpenClaw config: ${filePath}`)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

/**
 * Build the OpenClaw provider entry from metadata only. The API key value is
 * never accepted here; OpenClaw receives an env SecretRef instead.
 */
export function buildProviderConfig(
  input: EdictProviderInput,
  existing?: OpenClawProviderConfig,
): OpenClawProviderConfig {
  const providerId = openClawProviderId(input.id)
  const baseUrl = normalizeOpenAIBaseUrl(input.baseUrl)
  const previous: Partial<OpenClawProviderConfig> = existing ?? {}
  const previousHeaders = isRecord(previous.headers) ? { ...previous.headers } : {}
  for (const key of Object.keys(previousHeaders)) {
    if (key.toLowerCase() === 'user-agent') delete previousHeaders[key]
  }
  const config: OpenClawProviderConfig = {
    ...previous,
    baseUrl,
    api: 'openai-completions',
    auth: 'api-key',
    headers: { ...previousHeaders, 'User-Agent': EDICT_PROVIDER_USER_AGENT },
    models: normalizeModelDefinitions(input.models, previous.baseUrl === baseUrl ? previous.models : undefined),
  }

  // A secret is represented only by a SecretRef. Any legacy plaintext value
  // is removed rather than copied into the desktop-managed config.
  delete config.apiKey
  if (input.hasApiKey === true || input.secretStored === true) {
    config.apiKey = {
      source: 'env',
      provider: 'default',
      id: providerApiKeyEnvVar(providerId),
    }
  }
  return config
}

/** Sync one provider into models.providers without dropping other providers. */
export async function syncProviderToOpenClaw(
  filePath: string,
  input: EdictProviderInput,
): Promise<{ providerId: string; config: OpenClawProviderConfig }> {
  const providerId = openClawProviderId(input.id)
  const current = await readOpenClawConfig(filePath)
  const next = cloneConfig(current)
  next.models = { ...(next.models ?? {}) }
  next.models.mode ??= 'merge'
  next.models.providers = { ...(next.models.providers ?? {}) }
  const config = buildProviderConfig(input, next.models.providers[providerId])
  next.models.providers[providerId] = config
  await writeOpenClawConfig(filePath, next)
  return { providerId, config }
}

/** Remove only the provider managed by the matching ProviderStore id. */
export async function removeProviderFromOpenClaw(filePath: string, providerId: string): Promise<boolean> {
  const normalized = openClawProviderId(providerId)
  const current = await readOpenClawConfig(filePath)
  if (!current.models?.providers || !(normalized in current.models.providers)) return false
  const next = cloneConfig(current)
  delete next.models!.providers![normalized]
  await writeOpenClawConfig(filePath, next)
  return true
}

/** Resolve API keys in memory for an Edict-managed OpenClaw process. */
export async function buildProviderEnvironment(
  providers: readonly EdictProviderInput[],
  getApiKey: (providerId: string) => Promise<string | undefined>,
): Promise<Record<string, string>> {
  const environment: Record<string, string> = {}
  for (const provider of providers) {
    if (provider.enabled === false) continue
    const apiKey = await getApiKey(provider.id)
    if (apiKey?.trim()) environment[providerApiKeyEnvVar(provider.id)] = apiKey.trim()
  }
  return environment
}

function normalizeAgentManifestEntry(value: unknown, index: number): EdictAgentManifestEntry {
  assertObject(value, `agents.json entry ${index} is invalid`)
  const id = normalizeAgentId(value.id)
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id
  const subagents = isRecord(value.subagents) && Array.isArray(value.subagents.allowAgents)
    ? value.subagents.allowAgents.filter((item): item is string => typeof item === 'string' && AGENT_ID_PATTERN.test(item))
    : []
  return {
    id,
    name,
    ...(typeof value.workspace === 'string' ? { workspace: value.workspace } : {}),
    ...(typeof value.agentDir === 'string' ? { agentDir: value.agentDir } : {}),
    subagents: { allowAgents: subagents },
  }
}

/** Read the upstream agents.json registration manifest (no credentials). */
export async function readAgentsManifest(filePath: string): Promise<EdictAgentManifestEntry[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    throw new Error(`agents.json is not valid JSON: ${filePath}`)
  }
  if (!Array.isArray(parsed)) throw new Error('agents.json must contain an array')
  const entries = parsed.map(normalizeAgentManifestEntry)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`agents.json contains duplicate agent: ${entry.id}`)
    seen.add(entry.id)
  }
  return entries
}

function defaultModelFromConfig(config: OpenClawConfig): string | undefined {
  const model = config.agents?.defaults?.model
  if (typeof model === 'string') return model
  if (isRecord(model) && typeof model.primary === 'string') return model.primary
  return undefined
}

function primaryModel(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (isRecord(value) && typeof value.primary === 'string' && value.primary.trim()) return value.primary.trim()
  return undefined
}

/** Join agents.json registrations with the models in openclaw.json. */
export function mergeAgentModelBindings(
  manifest: readonly EdictAgentManifestEntry[],
  config: OpenClawConfig,
): AgentModelBinding[] {
  const defaultModel = defaultModelFromConfig(config)
  const runtimeAgents = new Map<string, Record<string, unknown>>()
  for (const agent of config.agents?.list ?? []) {
    if (typeof agent.id === 'string') runtimeAgents.set(agent.id, agent)
  }
  return manifest.map((entry) => {
    const runtime = runtimeAgents.get(entry.id)
    const model = primaryModel(runtime?.model) ?? defaultModel
    const separator = model?.indexOf('/') ?? -1
    return {
      agentId: entry.id,
      label: entry.name,
      ...(model ? { model } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      ...(model && separator > 0 ? { providerId: model.slice(0, separator), modelId: model.slice(separator + 1) } : {}),
      ...(entry.workspace ? { workspace: entry.workspace } : {}),
    }
  })
}

async function fetchJson(
  url: string,
  init: RequestInit,
  options: EdictApiOptions,
): Promise<Record<string, unknown>> {
  const requestFetch = options.fetch ?? ((input, requestInit) => fetch(input, requestInit))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000)
  try {
    const response = await requestFetch(url, { ...init, signal: controller.signal })
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      throw new Error(`EDICT API returned invalid JSON (HTTP ${response.status})`)
    }
    if (!response.ok) {
      const detail = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
      throw new Error(`EDICT API request failed: ${detail}`)
    }
    assertObject(payload, 'EDICT API response must be an object')
    return payload
  } catch (error) {
    if (error instanceof Error && /abort/i.test(error.name + error.message)) {
      throw new Error('EDICT API request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/** Queue an Agent model change through the original EDICT /api/set-model API. */
export async function setAgentModel(
  dashboardUrl: string,
  agentId: string,
  providerId: string,
  modelId: string,
  options: EdictApiOptions = {},
): Promise<SetAgentModelResult> {
  const baseUrl = normalizeText(dashboardUrl, 'dashboardUrl', 2_000).replace(/\/+$/, '')
  const normalizedAgentId = normalizeAgentId(agentId)
  const model = modelReference(providerId, modelId)
  const payload = await fetchJson(
    `${baseUrl}/api/set-model`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: normalizedAgentId, model }),
    },
    options,
  )
  return { ...payload, ok: payload.ok === true, agentId: normalizedAgentId, model }
}
