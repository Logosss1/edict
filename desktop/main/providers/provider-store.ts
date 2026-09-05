import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

import type { SecretStore } from './secret-store.js'
import {
  PROVIDER_STORE_VERSION,
  type ProviderDraft,
  type ProviderKind,
  type ProviderModel,
  type ProviderModelInput,
  type ProviderRecord,
  type ProviderStoreDocument,
  type ProviderSummary,
} from './types.js'

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CREDENTIAL_REF_PATTERN = /^provider\/[a-z0-9][a-z0-9._-]{0,63}\/api-key$/
const MAX_PROVIDER_NAME_LENGTH = 80
const MAX_MODEL_ID_LENGTH = 200

const KIND_ALIASES: Record<string, ProviderKind> = {
  anthropic: 'anthropic',
  custom: 'custom',
  google: 'google',
  'openai-compatible': 'openai-compatible',
  'openai_compatible': 'openai-compatible',
  openai: 'openai-compatible',
  newapi_channel_conn: 'openai-compatible',
}

export interface ProviderStoreOptions {
  metadataPath: string
  secretStore: SecretStore
  clock?: () => Date
  idFactory?: () => string
}

export interface ProviderConnectionOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

export class ProviderStoreError extends Error {
  readonly code: string

  constructor(message: string, code = 'PROVIDER_STORE_ERROR') {
    super(message)
    this.name = 'ProviderStoreError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

function cloneModel(model: ProviderModel): ProviderModel {
  return { ...model, ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: [...model.supportedReasoningEfforts] } : {}) }
}

function cloneRecord(record: ProviderRecord): ProviderRecord {
  return {
    ...record,
    models: record.models.map(cloneModel),
  }
}

function cloneRecords(records: ProviderRecord[]): ProviderRecord[] {
  return records.map(cloneRecord)
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProviderStoreError('Provider name is required', 'INVALID_NAME')
  }
  const name = value.trim()
  if (!name || name.length > MAX_PROVIDER_NAME_LENGTH) {
    throw new ProviderStoreError('Provider name must be 1-80 characters', 'INVALID_NAME')
  }
  return name
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProviderStoreError('Provider id must be a string', 'INVALID_ID')
  }
  const id = value.trim().toLowerCase()
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new ProviderStoreError('Provider id contains unsupported characters', 'INVALID_ID')
  }
  return id
}

function makeSlug(value: string, idFactory: () => string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (slug) return slug
  return `provider-${idFactory().replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`
}

function normalizeKind(value: unknown): ProviderKind {
  if (value === undefined || value === null || value === '') return 'openai-compatible'
  if (typeof value !== 'string') {
    throw new ProviderStoreError('Provider type is invalid', 'INVALID_KIND')
  }
  const kind = KIND_ALIASES[value.trim().toLowerCase()]
  if (!kind) throw new ProviderStoreError('Unsupported provider type', 'INVALID_KIND')
  return kind
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProviderStoreError('Provider base URL is required', 'INVALID_URL')
  }
  const candidate = value.trim()
  if (!candidate) throw new ProviderStoreError('Provider base URL is required', 'INVALID_URL')

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new ProviderStoreError('Provider base URL is invalid', 'INVALID_URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new ProviderStoreError('Provider base URL must use HTTP or HTTPS', 'INVALID_URL')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProviderStoreError('Provider base URL cannot contain credentials or query data', 'INVALID_URL')
  }
  return candidate.replace(/\/+$/, '')
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProviderStoreError('Model id is required', 'INVALID_MODEL')
  }
  const id = value.trim()
  if (!id || id.length > MAX_MODEL_ID_LENGTH) {
    throw new ProviderStoreError('Model id must be 1-200 characters', 'INVALID_MODEL')
  }
  return id
}

function normalizeModels(value: unknown): ProviderModel[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ProviderStoreError('Provider models must be an array', 'INVALID_MODEL')
  }
  const models: ProviderModel[] = []
  const seen = new Set<string>()
  for (const item of value as unknown[]) {
    if (typeof item === 'string') {
      const id = normalizeModelId(item)
      if (!seen.has(id)) {
        seen.add(id)
        models.push({ id, label: id })
      }
      continue
    }
    if (!isRecord(item)) throw new ProviderStoreError('Provider model is invalid', 'INVALID_MODEL')
    const id = normalizeModelId(item.id)
    if (seen.has(id)) continue
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id
    const contextWindow = item.contextWindow
    if (
      contextWindow !== undefined &&
      (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)
    ) {
      throw new ProviderStoreError('Model context window is invalid', 'INVALID_MODEL')
    }
    seen.add(id)
    const efforts = item.supportedReasoningEfforts
    if (efforts !== undefined && (!Array.isArray(efforts) || efforts.length > 16 ||
      efforts.some(level => typeof level !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(level)))) {
      throw new ProviderStoreError('Model reasoning efforts are invalid', 'INVALID_MODEL')
    }
    models.push({
      id, label, ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(typeof item.reasoning === 'boolean' ? { reasoning: item.reasoning } : {}),
      ...(Array.isArray(efforts) ? { supportedReasoningEfforts: [...new Set(efforts as string[])] } : {}),
    })
  }
  return models
}

function normalizeDefaultModelId(value: unknown, models: ProviderModel[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const id = normalizeModelId(value)
  if (!models.some((model) => model.id === id)) {
    throw new ProviderStoreError('Default model must be one of the configured models', 'INVALID_MODEL')
  }
  return id
}

function normalizeCredentialRef(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !CREDENTIAL_REF_PATTERN.test(value)) {
    throw new ProviderStoreError('Provider credential reference is invalid', 'INVALID_CREDENTIAL_REF')
  }
  return value
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) {
    throw new ProviderStoreError(`Provider ${field} timestamp is invalid`, 'INVALID_DOCUMENT')
  }
  return value
}

function normalizeStoredRecord(value: unknown): ProviderRecord {
  if (!isRecord(value)) throw new ProviderStoreError('Provider metadata is invalid', 'INVALID_DOCUMENT')
  if ('apiKey' in value || 'key' in value) {
    throw new ProviderStoreError('Provider metadata contains an insecure credential', 'INSECURE_DOCUMENT')
  }
  const id = normalizeId(value.id)
  const name = normalizeName(value.name)
  const kind = normalizeKind(value.kind)
  const baseUrl = normalizeBaseUrl(value.baseUrl)
  const models = normalizeModels(value.models)
  const defaultModelId = normalizeDefaultModelId(value.defaultModelId, models)
  const credentialRef = normalizeCredentialRef(value.credentialRef)
  if (credentialRef && credentialRef !== `provider/${id}/api-key`) {
    throw new ProviderStoreError('Provider credential reference does not match provider id', 'INVALID_DOCUMENT')
  }
  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== 'boolean') throw new ProviderStoreError('Provider enabled flag is invalid', 'INVALID_DOCUMENT')
  const createdAt = normalizeTimestamp(value.createdAt, 'createdAt')
  const updatedAt = normalizeTimestamp(value.updatedAt, 'updatedAt')
  return {
    id,
    name,
    kind,
    baseUrl,
    enabled,
    models,
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(credentialRef ? { credentialRef } : {}),
    createdAt,
    updatedAt,
  }
}

function normalizeApiKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProviderStoreError('API key cannot be empty', 'EMPTY_API_KEY')
  }
  return value.trim()
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  try {
    await chmod(path, 0o700)
  } catch {
    throw new ProviderStoreError('Unable to secure provider storage directory', 'PERMISSIONS_FAILED')
  }
}

export class ProviderStore {
  private document: ProviderStoreDocument | undefined
  private loading: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly clock: () => Date
  private readonly idFactory: () => string

  constructor(private readonly options: ProviderStoreOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
  }

  list(): Promise<ProviderSummary[]> {
    return this.runExclusive(async () => {
      await this.ensureLoaded()
      return Promise.all(this.document!.providers.map((provider) => this.toSummary(provider)))
    })
  }

  upsert(draft: ProviderDraft): Promise<ProviderSummary> {
    return this.runExclusive(async () => {
      await this.ensureLoaded()
      const name = normalizeName(draft.name)
      const requestedId = draft.id === undefined ? undefined : normalizeId(draft.id)
      const id = requestedId ?? this.nextId(name)
      const existing = this.document!.providers.find((provider) => provider.id === id)
      const previousProviders = cloneRecords(this.document!.providers)
      const previousRef = existing?.credentialRef
      const previousSecret = previousRef ? await this.options.secretStore.get(previousRef) : undefined
      const now = this.now()
      const baseUrl = normalizeBaseUrl(draft.baseUrl ?? draft.url)
      const kind = normalizeKind(draft.kind ?? draft.type ?? draft._type)
      const previousModels = existing?.baseUrl === baseUrl && existing.kind === kind ? existing.models : []
      const models = normalizeModels(draft.models).map(model => ({ ...previousModels.find(old => old.id === model.id), ...model }))
      const defaultModelId = normalizeDefaultModelId(draft.defaultModelId, models)
      const record: ProviderRecord = {
        id,
        name,
        kind,
        baseUrl,
        enabled: draft.enabled ?? true,
        models,
        ...(defaultModelId ? { defaultModelId } : {}),
        ...(existing?.credentialRef ? { credentialRef: existing.credentialRef } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      if (typeof record.enabled !== 'boolean') {
        throw new ProviderStoreError('Provider enabled flag is invalid', 'INVALID_ENABLED')
      }

      let secretChanged = false
      let changedRef: string | undefined
      try {
        if (Object.prototype.hasOwnProperty.call(draft, 'apiKey')) {
          if (draft.apiKey === null) {
            if (previousRef) {
              await this.options.secretStore.delete(previousRef)
              secretChanged = true
              changedRef = previousRef
            }
            delete record.credentialRef
          } else {
            const apiKey = normalizeApiKey(draft.apiKey)
            const credentialRef = previousRef ?? `provider/${id}/api-key`
            await this.options.secretStore.set(credentialRef, apiKey)
            secretChanged = true
            changedRef = credentialRef
            record.credentialRef = credentialRef
          }
        }
        this.document!.providers = existing
          ? this.document!.providers.map((provider) => (provider.id === id ? record : provider))
          : [...this.document!.providers, record]
        await this.persist()
      } catch (error) {
        this.document!.providers = previousProviders
        await this.rollbackSecret(changedRef, previousRef, previousSecret, secretChanged)
        throw error
      }
      return this.toSummary(record)
    })
  }

  getApiKey(id: string): Promise<string | undefined> {
    const providerId = normalizeId(id)
    return this.runExclusive(async () => {
      await this.ensureLoaded()
      const provider = this.requireProvider(providerId)
      return provider.credentialRef ? this.options.secretStore.get(provider.credentialRef) : undefined
    })
  }

  remove(id: string): Promise<boolean> {
    const providerId = normalizeId(id)
    return this.runExclusive(async () => {
      await this.ensureLoaded()
      const provider = this.document!.providers.find((item) => item.id === providerId)
      if (!provider) return false
      const previousProviders = cloneRecords(this.document!.providers)
      const previousRef = provider.credentialRef
      const previousSecret = previousRef ? await this.options.secretStore.get(previousRef) : undefined
      let secretChanged = false
      try {
        if (previousRef) {
          await this.options.secretStore.delete(previousRef)
          secretChanged = true
        }
        this.document!.providers = this.document!.providers.filter((item) => item.id !== providerId)
        await this.persist()
      } catch (error) {
        this.document!.providers = previousProviders
        await this.rollbackSecret(previousRef, previousRef, previousSecret, secretChanged)
        throw error
      }
      return true
    })
  }

  private requireProvider(id: string): ProviderRecord {
    const provider = this.document!.providers.find((item) => item.id === id)
    if (!provider) throw new ProviderStoreError('Provider was not found', 'NOT_FOUND')
    return provider
  }

  private nextId(name: string): string {
    const base = makeSlug(name, this.idFactory)
    if (!this.document!.providers.some((provider) => provider.id === base)) return base
    let attempt = `${base}-${this.idFactory().replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`
    while (this.document!.providers.some((provider) => provider.id === attempt)) {
      attempt = `${base}-${this.idFactory().replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`
    }
    return normalizeId(attempt)
  }

  private now(): string {
    const value = this.clock()
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ProviderStoreError('Provider clock returned an invalid date', 'INVALID_CLOCK')
    }
    return value.toISOString()
  }

  private async toSummary(provider: ProviderRecord): Promise<ProviderSummary> {
    const hasApiKey = provider.credentialRef
      ? (await this.options.secretStore.get(provider.credentialRef)) !== undefined
      : false
    const { credentialRef: _credentialRef, ...safeRecord } = cloneRecord(provider)
    return { ...safeRecord, hasApiKey }
  }

  private async rollbackSecret(
    changedRef: string | undefined,
    previousRef: string | undefined,
    previousSecret: string | undefined,
    secretChanged: boolean,
  ): Promise<void> {
    if (!secretChanged || !changedRef) return
    try {
      if (previousRef && previousSecret !== undefined) {
        await this.options.secretStore.set(previousRef, previousSecret)
      } else {
        await this.options.secretStore.delete(changedRef)
      }
    } catch {
      // Preserve the original failure. A subsequent startup can report the
      // secure-store error without exposing credential contents.
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async ensureLoaded(): Promise<void> {
    if (this.document) return
    if (!this.loading) {
      this.loading = this.readDocument().finally(() => {
        this.loading = undefined
      })
    }
    await this.loading
  }

  private async readDocument(): Promise<void> {
    await secureDirectory(dirname(this.options.metadataPath))

    let raw: string
    try {
      raw = await readFile(this.options.metadataPath, 'utf8')
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        this.document = { version: PROVIDER_STORE_VERSION, providers: [] }
        return
      }
      throw new ProviderStoreError('Unable to read provider metadata', 'READ_FAILED')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ProviderStoreError('Provider metadata is not valid JSON', 'INVALID_DOCUMENT')
    }
    if (!isRecord(parsed) || parsed.version !== PROVIDER_STORE_VERSION || !Array.isArray(parsed.providers)) {
      throw new ProviderStoreError('Provider metadata has an unsupported format', 'INVALID_DOCUMENT')
    }
    const providers = parsed.providers.map(normalizeStoredRecord)
    const ids = new Set<string>()
    for (const provider of providers) {
      if (ids.has(provider.id)) throw new ProviderStoreError('Provider metadata has duplicate ids', 'INVALID_DOCUMENT')
      ids.add(provider.id)
    }
    this.document = { version: PROVIDER_STORE_VERSION, providers }
    try {
      await chmod(this.options.metadataPath, 0o600)
    } catch {
      throw new ProviderStoreError('Unable to secure provider metadata file', 'PERMISSIONS_FAILED')
    }
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.options.metadataPath)
    await secureDirectory(directory)
    const temporaryPath = `${this.options.metadataPath}.${randomUUID()}.tmp`
    const body = `${JSON.stringify(this.document)}\n`
    try {
      await writeFile(temporaryPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, this.options.metadataPath)
      await chmod(this.options.metadataPath, 0o600)
    } catch {
      throw new ProviderStoreError('Unable to persist provider metadata', 'WRITE_FAILED')
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }
}

export interface ProviderConnectionTestResult {
  ok: boolean
  providerId?: string
  baseUrl?: string
  endpoint?: string
  models?: string[]
  modelDefinitions?: ProviderModelInput[]
  modelCount?: number
  latencyMs?: number
  status?: number
  error?: string
}

export type ProviderFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

function redactCredential(value: string, apiKey: string): string {
  const secret = apiKey.trim()
  if (!secret) return value
  return value.split(secret).join('[redacted]')
}

function modelIdsFromResponse(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const id = typeof item === 'string' ? item : isRecord(item) && typeof item.id === 'string' ? item.id : ''
    const normalized = id.trim()
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      ids.push(normalized)
    }
  }
  return ids
}

function modelDefinitionsFromResponse(value: unknown): ProviderModelInput[] {
  const items = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.data) ? value.data : []
  return items.flatMap(item => {
    if (!isRecord(item) || typeof item.id !== 'string') return []
    const compat = isRecord(item.compat) ? item.compat : {}
    const rawEfforts = item.supportedReasoningEfforts ?? compat.supportedReasoningEfforts
    const efforts = Array.isArray(rawEfforts) && rawEfforts.length <= 16 &&
      rawEfforts.every(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level))
      ? [...new Set(rawEfforts as string[])] : undefined
    return [{
      id: item.id.trim(),
      ...(typeof item.reasoning === 'boolean' ? { reasoning: item.reasoning } : {}),
      ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
    }]
  })
}

function modelEndpoints(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, '')
  const candidates = /\/v1$/i.test(normalized)
    ? [`${normalized}/models`, `${normalized.slice(0, -3)}/models`]
    : [`${normalized}/v1/models`, `${normalized}/models`]
  return [...new Set(candidates)]
}

/**
 * Performs a bounded, read-only OpenAI-compatible model discovery request.
 * The API key is accepted only in memory and is never included in the result.
 */
export async function testProviderConnection(
  draft: ProviderDraft,
  apiKey: string | undefined,
  options: ProviderConnectionOptions = {},
): Promise<ProviderConnectionTestResult> {
  let providerId: string | undefined
  let baseUrl: string
  try {
    providerId = draft.id ? normalizeId(draft.id) : undefined
    baseUrl = normalizeBaseUrl(draft.baseUrl ?? draft.url)
    const kind = normalizeKind(draft.kind ?? draft.type ?? draft._type)
    if (kind !== 'openai-compatible') {
      return { ok: false, providerId, baseUrl, error: '当前阶段只支持 OpenAI 兼容供应商测试' }
    }
  } catch (error) {
    return { ok: false, providerId, error: error instanceof Error ? error.message : String(error) }
  }

  if (!apiKey?.trim()) {
    return { ok: false, providerId, baseUrl, error: '请先填写 API Key，或选择已有密钥的供应商' }
  }

  let lastStatus: number | undefined
  let lastEndpoint: string | undefined
  let lastLatencyMs: number | undefined
  let lastError = ''
  let timedOut = false
  const requestFetch: ProviderFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 12_000
  for (const endpoint of modelEndpoints(baseUrl)) {
    const startedAt = Date.now()
    lastEndpoint = endpoint
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await requestFetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        signal: controller.signal,
        redirect: 'error',
      })
      lastStatus = response.status
      if (response.ok) {
        let payload: unknown = null
        try {
          payload = await response.json()
        } catch {
          return {
            ok: false,
            providerId,
            baseUrl,
            endpoint,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            error: '供应商返回的模型列表不是有效 JSON',
          }
        }
        const models = modelIdsFromResponse(payload)
        return {
          ok: true,
          providerId,
          baseUrl,
          endpoint,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          models,
          modelDefinitions: modelDefinitionsFromResponse(payload),
          modelCount: models.length,
        }
      }
      if (![404, 405].includes(response.status)) {
        return {
          ok: false,
          providerId,
          baseUrl,
          endpoint,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          error: `供应商返回 HTTP ${response.status}`,
        }
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = redactCredential(error instanceof Error ? error.message : String(error), apiKey)
      if (/abort/i.test(lastError)) {
        timedOut = true
        lastError = '请求超时'
        continue
      }
      break
    } finally {
      lastLatencyMs = Date.now() - startedAt
      clearTimeout(timeout)
    }
  }

  return {
    ok: false,
    providerId,
    baseUrl,
    endpoint: lastEndpoint,
    status: lastStatus,
    latencyMs: lastLatencyMs,
    error: timedOut ? '无法读取模型列表（请求超时）' : lastError ? `无法读取模型列表（${lastError}）` : '无法读取模型列表',
  }
}
