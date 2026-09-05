export const PROVIDER_STORE_VERSION = 1 as const

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'google' | 'custom'

export interface ProviderModel {
  id: string
  label: string
  contextWindow?: number
  reasoning?: boolean
  supportedReasoningEfforts?: string[]
}

export interface ProviderModelInput {
  id: string
  label?: string
  contextWindow?: number
  reasoning?: boolean
  supportedReasoningEfforts?: string[]
}

/** Input accepted by the settings UI. `apiKey` is never written to metadata. */
export interface ProviderDraft {
  id?: string
  name: string
  kind?: ProviderKind | string
  /** Alias accepted for settings/import forms that call this field `type`. */
  type?: ProviderKind | string
  /** Alias accepted for the original New API channel shape. */
  _type?: string
  baseUrl?: string
  url?: string
  apiKey?: string | null
  models?: ProviderModelInput[]
  defaultModelId?: string | null
  enabled?: boolean
}

/** The on-disk record. It contains only a reference to the encrypted secret. */
export interface ProviderRecord {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  enabled: boolean
  models: ProviderModel[]
  defaultModelId?: string
  credentialRef?: string
  createdAt: string
  updatedAt: string
}

/** Safe-to-render provider data. The API key itself is intentionally absent. */
export interface ProviderSummary extends Omit<ProviderRecord, 'credentialRef'> {
  hasApiKey: boolean
}

export interface ProviderStoreDocument {
  version: typeof PROVIDER_STORE_VERSION
  providers: ProviderRecord[]
}
