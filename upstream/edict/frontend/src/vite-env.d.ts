/// <reference types="vite/client" />

interface EdictDesktopProviderSummary {
  id: string
  name: string
  type?: string
  baseUrl: string
  models: string[]
  defaultModel?: string
  secretStored: boolean
  enabled?: boolean
}

interface EdictDesktopProviderPayload {
  id?: string
  name: string
  type: 'openai-compatible'
  baseUrl: string
  apiKey?: string
  models: string[]
  defaultModelId?: string
}

interface EdictDesktopProviderTestResult {
  ok: boolean
  models?: string[]
  modelCount?: number
  endpoint?: string
  status?: number
  latencyMs?: number
  error?: string
}

interface Window {
  edictDesktop?: {
    listProviders: () => Promise<EdictDesktopProviderSummary[]>
    saveProvider: (payload: EdictDesktopProviderPayload) => Promise<EdictDesktopProviderSummary & {
      integration?: { ok?: boolean; error?: string }
    }>
    testProvider: (payload: EdictDesktopProviderPayload) => Promise<EdictDesktopProviderTestResult>
    openSettings?: (tab?: string) => Promise<unknown>
  }
}
