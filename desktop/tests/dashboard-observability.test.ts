import { describe, expect, it } from 'vitest'

import {
  DashboardObservabilityClient,
  summarizeDashboardErrors,
} from '../main/dashboard-observability.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('DashboardObservabilityClient', () => {
  it('aggregates original EDICT health, tasks, agents, activity, and scheduler APIs', async () => {
    const requests: string[] = []
    const client = new DashboardObservabilityClient({
      baseUrl: 'http://127.0.0.1:9876/',
      runtime: { dashboardPid: 123, dashboardRunning: true, autoDispatchEnabled: false },
      fetch: async (input) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith('/healthz')) return response({ status: 'ok' })
        if (url.endsWith('/api/live-status')) {
          return response({ tasks: [
            { id: 'JJC-1', title: '正在执行', state: 'Doing', org: '工部' },
            { id: 'JJC-2', title: '已完成', state: 'Done', org: '礼部' },
          ] })
        }
        if (url.endsWith('/api/agents-status')) return response({ ok: true, agents: [{ id: 'gongbu', status: 'running' }] })
        if (url.endsWith('/api/agent-config')) return response({ agents: [{ id: 'gongbu', model: 'provider/model' }] })
        if (url.endsWith('/api/task-activity/JJC-1')) return response({ ok: true, activity: [{ kind: 'tool' }] })
        if (url.endsWith('/api/scheduler-state/JJC-1')) return response({ ok: true, taskId: 'JJC-1', stalledSec: 2 })
        throw new Error(`unexpected request ${url}`)
      },
    })

    const snapshot = await client.getSnapshot({ includeOutputs: false })
    expect(snapshot.health).toEqual({ status: 'ok' })
    expect(snapshot.tasks).toHaveLength(2)
    expect(snapshot.activeTasks.map((task) => task.id)).toEqual(['JJC-1'])
    expect(snapshot.currentTask?.id).toBe('JJC-1')
    expect(snapshot.taskActivities['JJC-1']).toMatchObject({ ok: true })
    expect(snapshot.schedulerStates['JJC-1']).toMatchObject({ stalledSec: 2 })
    expect(snapshot.taskOutputs).toEqual({})
    expect(snapshot.runtime).toMatchObject({ dashboardPid: 123, dashboardRunning: true, autoDispatchEnabled: false })
    expect(requests).toEqual(expect.arrayContaining([
      'http://127.0.0.1:9876/healthz',
      'http://127.0.0.1:9876/api/live-status',
      'http://127.0.0.1:9876/api/agents-status',
      'http://127.0.0.1:9876/api/agent-config',
      'http://127.0.0.1:9876/api/task-activity/JJC-1',
      'http://127.0.0.1:9876/api/scheduler-state/JJC-1',
    ]))
    expect(requests.some((url) => url.includes('JJC-2'))).toBe(false)
  })

  it('keeps partial failures visible instead of failing the whole status view', async () => {
    const client = new DashboardObservabilityClient({
      baseUrl: 'http://127.0.0.1:9877',
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith('/healthz')) return response({ status: 'ok' })
        if (url.endsWith('/api/live-status')) return response({ tasks: [{ id: 'JJC-1', state: 'Doing' }] })
        if (url.endsWith('/api/agents-status')) return response({ ok: true, agents: [] }, 503)
        if (url.endsWith('/api/agent-config')) throw new Error('connection refused')
        if (url.includes('/api/task-activity/')) return response({ ok: true, activity: [] })
        if (url.includes('/api/scheduler-state/')) return response({ ok: true })
        throw new Error('unexpected request')
      },
    })

    const snapshot = await client.getSnapshot()
    expect(snapshot.tasks).toHaveLength(1)
    expect(snapshot.agentsStatus).toBeNull()
    expect(snapshot.agentConfig).toBeNull()
    expect(snapshot.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: '/api/agents-status', message: 'HTTP 503' }),
      expect.objectContaining({ endpoint: '/api/agent-config', message: 'connection refused' }),
    ]))
    expect(summarizeDashboardErrors({ ...snapshot, runtime: { startupError: '启动失败' } })).toEqual(expect.arrayContaining([
      'startup: 启动失败',
      '/api/agents-status: HTTP 503',
    ]))
  })
})

