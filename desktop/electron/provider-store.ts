import { safeStorage } from 'electron'
import { join } from 'node:path'

import {
  ElectronSafeStorageCipher,
  EncryptedFileSecretStore,
} from '../main/providers/secret-store.js'
import {
  ProviderStore as CoreProviderStore,
  testProviderConnection as testCoreProviderConnection,
  type ProviderConnectionOptions,
} from '../main/providers/provider-store.js'
import type {
  ProviderDraft as CoreProviderDraft,
  ProviderModelInput,
  ProviderSummary,
} from '../main/providers/types.js'

/** Settings-window payload. API keys are accepted only for the save operation. */
export interface ProviderDraft {
  id?: string
  name: string
  type?: string
  kind?: string
  _type?: string
  baseUrl?: string
  url?: string
  apiKey?: string | null
  models?: Array<string | ProviderModelInput>
  defaultModel?: string | null
  defaultModelId?: string | null
  enabled?: boolean
}

type UiProviderSummary = Omit<ProviderSummary, 'kind' | 'models' | 'defaultModelId' | 'hasApiKey'> & {
  type: ProviderSummary['kind']
  models: string[]
  modelDefinitions: ProviderSummary['models']
  defaultModel?: string
  secretStored: boolean
}

function toCoreDraft(input: ProviderDraft): CoreProviderDraft {
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey : undefined
  const models = input.models?.map((model) => (typeof model === 'string' ? { id: model } : model))
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    type: input.type,
    _type: input._type,
    baseUrl: input.baseUrl,
    url: input.url,
    ...(apiKey === undefined ? {} : { apiKey }),
    models,
    defaultModelId: input.defaultModelId ?? input.defaultModel ?? null,
    enabled: input.enabled,
  }
}

function toUiSummary(provider: ProviderSummary): UiProviderSummary {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.kind,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    models: provider.models.map((model) => model.id),
    modelDefinitions: provider.models,
    ...(provider.defaultModelId ? { defaultModel: provider.defaultModelId } : {}),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    secretStored: provider.hasApiKey,
  }
}

/**
 * Electron-facing facade. It keeps the renderer payload compatible with the
 * settings page while the core store keeps secrets and metadata separate.
 */
export class ProviderStore {
  private readonly core: CoreProviderStore
  private readonly secrets: EncryptedFileSecretStore

  constructor(userDataDirectory: string) {
    const settingsDirectory = join(userDataDirectory, 'edict')
    this.secrets = new EncryptedFileSecretStore(
      join(settingsDirectory, 'credentials.json'),
      new ElectronSafeStorageCipher(safeStorage),
    )
    this.core = new CoreProviderStore({
      metadataPath: join(settingsDirectory, 'providers.json'),
      secretStore: this.secrets,
    })
  }

  async list(): Promise<UiProviderSummary[]> {
    const providers = await this.core.list()
    return providers.map(toUiSummary)
  }

  async save(input: ProviderDraft): Promise<UiProviderSummary> {
    const provider = await this.core.upsert(toCoreDraft(input))
    return toUiSummary(provider)
  }

  remove(providerId: string): Promise<boolean> {
    return this.core.remove(providerId)
  }

  getSecret(providerId: string): Promise<string | undefined> {
    return this.core.getApiKey(providerId)
  }

  getCredential(ref: string): Promise<string | undefined> {
    return this.secrets.get(ref)
  }

  setCredential(ref: string, value: string): Promise<void> {
    return this.secrets.set(ref, value)
  }

  deleteCredential(ref: string): Promise<void> {
    return this.secrets.delete(ref)
  }
}

export async function testProviderConnection(
  input: ProviderDraft,
  apiKey?: string | Promise<string | undefined>,
  options?: ProviderConnectionOptions,
) {
  const secret = await apiKey
  return testCoreProviderConnection(toCoreDraft(input), secret, options)
}
