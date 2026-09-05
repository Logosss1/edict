export interface DashboardFetchOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface DashboardRuntimeInfo {
  dashboardPid?: number | null
  dashboardRunning?: boolean
  python?: string
  dashboardUrl?: string
  startupState?: string
  startupError?: string
  autoDispatchEnabled?: boolean
  openclawBinary?: string
  openclawVersion?: string
}

export interface DashboardTask {
  id: string
  title?: string
  state?: string
  org?: string
  official?: string
  now?: string
  block?: string
  archived?: boolean
  updatedAt?: string
  heartbeat?: Record<string, unknown> | null
  sourceMeta?: Record<string, unknown>
  [key: string]: unknown
}

export interface DashboardError {
  endpoint: string
  message: string
}

export interface DashboardObservabilitySnapshot {
  checkedAt: string
  health: Record<string, unknown> | null
  liveStatus: Record<string, unknown> | null
  tasks: DashboardTask[]
  activeTasks: DashboardTask[]
  currentTask: DashboardTask | null
  agentsStatus: Record<string, unknown> | null
  agentConfig: Record<string, unknown> | null
  taskActivities: Record<string, unknown>
  schedulerStates: Record<string, unknown>
  taskOutputs: Record<string, unknown>
  agentActivities: Record<string, unknown>
  runtime: DashboardRuntimeInfo
  errors: DashboardError[]
}

export interface DashboardObservabilityOptions extends DashboardFetchOptions {
  maxTrackedTasks?: number
  includeOutputs?: boolean
  includeActivity?: boolean
  includeScheduler?: boolean
  includeHealth?: boolean
  includeAgentActivity?: boolean
  activeStates?: string[]
}

export interface DashboardObservabilityClientOptions extends DashboardFetchOptions {
  baseUrl: string
  runtime?: DashboardRuntimeInfo
}

const DEFAULT_ACTIVE_STATES = [
  'Taizi',
  'Zhongshu',
  'Menxia',
  'Assigned',
  'Doing',
  'Review',
  'Next',
  'Pending',
  'Blocked',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asTasks(value: unknown): DashboardTask[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is DashboardTask => isRecord(item) && typeof item.id === 'string')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}

function parseJsonResponse(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function agentIds(value: unknown): string[] {
  const agents = isRecord(value) && Array.isArray(value.agents) ? value.agents : []
  return agents
    .map((item) => isRecord(item) ? (typeof item.id === 'string' ? item.id : item.agentId) : undefined)
    .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    .map((id) => id.trim())
}

/**
 * Read-only adapter for the existing EDICT dashboard APIs. It deliberately
 * does not create a second task state machine; all state comes from the
 * original server endpoints.
 */
export class DashboardObservabilityClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly baseUrl: string
  private readonly runtime: DashboardRuntimeInfo

  constructor(options: DashboardObservabilityClientOptions) {
    if (!options.baseUrl?.trim()) throw new Error('Dashboard base URL is required')
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.runtime = { ...(options.runtime ?? {}) }
  }

  async getSnapshot(options: DashboardObservabilityOptions = {}): Promise<DashboardObservabilitySnapshot> {
    const errors: DashboardError[] = []
    const includeHealth = options.includeHealth ?? true
    const includeActivity = options.includeActivity ?? true
    const includeScheduler = options.includeScheduler ?? true
    const includeOutputs = options.includeOutputs ?? false
    const includeAgentActivity = options.includeAgentActivity ?? true
    const maxTrackedTasks = Math.max(0, Math.min(50, Math.floor(options.maxTrackedTasks ?? 12)))

    const request = async (path: string): Promise<unknown | null> => {
      const endpoint = endpointUrl(this.baseUrl, path)
      try {
        const response = await this.fetchImpl(endpoint, {
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { Accept: 'application/json' },
        })
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return body
      } catch (error) {
        errors.push({ endpoint: path, message: errorMessage(error) })
        return null
      }
    }

    const [healthValue, liveValue, agentsValue, configValue] = await Promise.all([
      includeHealth ? request('/healthz') : Promise.resolve(null),
      request('/api/live-status'),
      request('/api/agents-status'),
      request('/api/agent-config'),
    ])
    const liveStatus = parseJsonResponse(liveValue)
    const tasks = asTasks(liveStatus.tasks)
    const activeStates = new Set(options.activeStates ?? DEFAULT_ACTIVE_STATES)
    const activeTasks = tasks.filter((task) => !task.archived && activeStates.has(String(task.state ?? '')))
    const trackedTasks = activeTasks.slice(0, maxTrackedTasks)

    const activityEntries = includeActivity
      ? await Promise.all(trackedTasks.map(async (task) => [task.id, await request(`/api/task-activity/${encodeURIComponent(task.id)}`)] as const))
      : []
    const schedulerEntries = includeScheduler
      ? await Promise.all(trackedTasks.map(async (task) => [task.id, await request(`/api/scheduler-state/${encodeURIComponent(task.id)}`)] as const))
      : []
    const outputEntries = includeOutputs
      ? await Promise.all(trackedTasks.map(async (task) => [task.id, await request(`/api/task-output/${encodeURIComponent(task.id)}`)] as const))
      : []
    const agentActivityEntries = includeAgentActivity
      ? await Promise.all(agentIds(agentsValue).slice(0, 20).map(async (id) => [id, await request(`/api/agent-activity/${encodeURIComponent(id)}`)] as const))
      : []

    const taskActivities: Record<string, unknown> = {}
    for (const [id, value] of activityEntries) if (value !== null) taskActivities[id] = value
    const schedulerStates: Record<string, unknown> = {}
    for (const [id, value] of schedulerEntries) if (value !== null) schedulerStates[id] = value
    const taskOutputs: Record<string, unknown> = {}
    for (const [id, value] of outputEntries) if (value !== null) taskOutputs[id] = value
    const agentActivities: Record<string, unknown> = {}
    for (const [id, value] of agentActivityEntries) if (value !== null) agentActivities[id] = value

    return {
      checkedAt: new Date().toISOString(),
      health: healthValue === null ? null : parseJsonResponse(healthValue),
      liveStatus: liveValue === null ? null : liveStatus,
      tasks,
      activeTasks,
      currentTask: activeTasks[0] ?? null,
      agentsStatus: agentsValue === null ? null : parseJsonResponse(agentsValue),
      agentConfig: configValue === null ? null : parseJsonResponse(configValue),
      taskActivities,
      schedulerStates,
      taskOutputs,
      agentActivities,
      runtime: { ...this.runtime, dashboardUrl: this.baseUrl },
      errors,
    }
  }

}

export function summarizeDashboardErrors(snapshot: DashboardObservabilitySnapshot): string[] {
  const messages = snapshot.errors.map((error) => `${error.endpoint}: ${error.message}`)
  const startupError = snapshot.runtime.startupError?.trim()
  if (startupError) messages.unshift(`startup: ${startupError}`)
  return [...new Set(messages)]
}
