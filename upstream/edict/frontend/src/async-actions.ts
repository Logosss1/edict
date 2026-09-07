import { api, type LiveStatus, type Task } from './api'

export type TaskOperation = 'stop' | 'cancel' | 'resume' | 'dispatch'
export type TaskOperationResult = 'confirmed' | 'failed' | 'timeout'

export interface WaitForTaskOperationOptions {
  timeoutMs?: number
  intervalMs?: number
  fetchStatus?: () => Promise<LiveStatus>
}

export interface WaitForTaskOperationResult {
  status: TaskOperationResult
  task?: Task
  detail?: string
}

const DISPATCH_PROGRESS = new Set(['queued', 'dispatching', 'waiting_gateway', 'running', 'retrying', 'success', 'disabled', 'not_needed'])
const DISPATCH_FAILURE = new Set(['gateway-offline', 'openclaw-missing', 'timeout', 'failed', 'error'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function operationConfirmed(task: Task, operation: TaskOperation, expectedState?: string): boolean {
  const status = String(task._scheduler?.lastDispatchStatus || 'idle')
  if (operation === 'stop') return task.state === 'Blocked'
  if (operation === 'cancel') return task.state === 'Cancelled'
  if (operation === 'dispatch') return DISPATCH_PROGRESS.has(status)
  if (task.state === 'Blocked' || task.state === 'Cancelled') return false
  if (expectedState && task.state !== expectedState) return false
  return DISPATCH_PROGRESS.has(status) || status === 'idle'
}

function operationFailed(task: Task, operation: TaskOperation): boolean {
  const status = String(task._scheduler?.lastDispatchStatus || '')
  return (operation === 'resume' || operation === 'dispatch')
    && task.state === 'Blocked'
    && DISPATCH_FAILURE.has(status)
}

/**
 * Wait until the server's persisted task state reflects an async action.
 * Buttons should not report success merely because the POST request returned;
 * the scheduler may still be starting or may immediately record a failure.
 */
export async function waitForTaskOperation(
  taskId: string,
  operation: TaskOperation,
  expectedState?: string,
  options: WaitForTaskOperationOptions = {},
): Promise<WaitForTaskOperationResult> {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000)
  const intervalMs = Math.max(100, options.intervalMs ?? 700)
  const fetchStatus = options.fetchStatus || api.liveStatus
  const deadline = Date.now() + timeoutMs
  let latest: Task | undefined
  let lastError = ''

  while (Date.now() <= deadline) {
    try {
      const live = await fetchStatus()
      latest = live.tasks?.find((task) => task.id === taskId)
      if (!latest) return { status: 'failed', detail: `任务 ${taskId} 已不在当前任务列表中。` }
      if (operationFailed(latest, operation)) {
        return { status: 'failed', task: latest, detail: latest._scheduler?.lastDispatchError || latest.block || '调度器记录了失败。' }
      }
      if (operationConfirmed(latest, operation, expectedState)) return { status: 'confirmed', task: latest }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() + intervalMs > deadline) break
    await sleep(intervalMs)
  }

  return {
    status: 'timeout',
    task: latest,
    detail: lastError || '后台仍在处理，暂未收到最终状态。',
  }
}
