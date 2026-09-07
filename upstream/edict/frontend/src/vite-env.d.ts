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

interface EdictDesktopChannelSummary {
  channel: string
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

interface EdictDesktopChannelListResult {
  ok: boolean
  channels: EdictDesktopChannelSummary[]
}

interface EdictDesktopChannelProbeResult {
  ok: boolean
  message: string
  raw?: unknown
}

interface EdictDesktopGatewayProbeResult {
  ok: boolean
  message: string
}

interface EdictDesktopWorkspaceAccessCheck {
  ok: boolean
  path: string
  readable?: boolean
  writable?: boolean
  traversable?: boolean
  probePassed?: boolean
  needsSystemPermission?: boolean
  detail: string
}

interface EdictDesktopWorkspaceProject {
  id: string
  name: string
  path: string
  createdAt?: string
  updatedAt?: string
}

interface EdictDesktopWorkspace {
  id: string
  name: string
  path: string
  projectPath: string | null
  projects: EdictDesktopWorkspaceProject[]
}

interface EdictDesktopWorkspaceState {
  activeWorkspaceId: string | null
  activeWorkspace: EdictDesktopWorkspace | null
  workspaces: EdictDesktopWorkspace[]
}

interface Window {
  edictDesktop?: {
    listProviders: () => Promise<EdictDesktopProviderSummary[]>
    saveProvider: (payload: EdictDesktopProviderPayload) => Promise<EdictDesktopProviderSummary & {
      integration?: { ok?: boolean; error?: string }
    }>
    testProvider: (payload: EdictDesktopProviderPayload) => Promise<EdictDesktopProviderTestResult>
    listChannelAccounts?: () => Promise<EdictDesktopChannelListResult>
    saveChannelAccount?: (payload: Record<string, unknown>) => Promise<{ ok: boolean; requiresReload?: boolean; account?: EdictDesktopChannelSummary; error?: string }>
    removeChannelAccount?: (payload: { channel: string; accountId: string }) => Promise<{ ok: boolean; requiresReload?: boolean }>
    probeChannelAccount?: (payload: { channel: string; accountId: string }) => Promise<EdictDesktopChannelProbeResult>
    probeGateway?: () => Promise<EdictDesktopGatewayProbeResult>
    reloadDashboard?: () => Promise<unknown>
    openSettings?: (tab?: string) => Promise<unknown>
    openMonitor?: () => Promise<unknown>
    getWorkspaceState?: () => Promise<EdictDesktopWorkspaceState>
    chooseWorkspace?: (mode?: 'create' | 'existing') => Promise<unknown>
    activateWorkspace?: (id: string) => Promise<unknown>
    chooseProject?: () => Promise<unknown>
    useWorkspaceAsProject?: () => Promise<unknown>
    checkWorkspaceAccess?: (path?: string) => Promise<EdictDesktopWorkspaceAccessCheck>
    openWorkspacePermissions?: () => Promise<{ ok: boolean; message?: string }>
  }
}
