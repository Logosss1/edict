const api = window.edictDesktop

const els = {
  updated: document.querySelector('#updated'),
  runtime: document.querySelector('#runtime-strip'),
  taskCount: document.querySelector('#task-count'),
  taskList: document.querySelector('#task-list'),
  detailTitle: document.querySelector('#detail-title'),
  detailMeta: document.querySelector('#detail-meta'),
  detailState: document.querySelector('#detail-state'),
  detailBody: document.querySelector('#detail-body'),
  taskActions: document.querySelector('#task-actions'),
  agents: document.querySelector('#agent-list'),
  errors: document.querySelector('#error-list'),
}

let snapshot = null
let selectedTaskId = ''
let loading = false

function text(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function escape(value) {
  return text(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]))
}

function stateClass(state) {
  if (['Doing', 'Assigned', 'Taizi', 'Zhongshu', 'Menxia', 'Review', 'Next', 'Pending'].includes(state)) return 'active'
  if (['Blocked', 'Cancelled'].includes(state)) return 'error'
  if (state === 'Done') return 'done'
  return 'neutral'
}

function stateLabel(state) {
  return ({ Doing: '执行中', Assigned: '已派发', Taizi: '太子分拣', Zhongshu: '中书起草', Menxia: '门下审议', Review: '待审查', Next: '待执行', Pending: '待处理', Done: '已完成', Blocked: '阻塞', Cancelled: '已取消' })[state] || text(state, '未知')
}

function jsonPreview(value) {
  try { return JSON.stringify(value, null, 2) } catch { return text(value) }
}

function renderRuntime() {
  const runtime = snapshot?.runtime || {}
  const health = snapshot?.health || {}
  const agentStatus = snapshot?.agentsStatus || {}
  const gatewayOnline = Array.isArray(agentStatus.agents) && agentStatus.agents.some((agent) => ['running', 'idle'].includes(agent.status))
  const items = [
    ['Python PID', runtime.dashboardPid || '未启动', runtime.dashboardRunning ? 'ok' : 'error'],
    ['看板', runtime.dashboardRunning ? '运行中' : '未运行', runtime.dashboardRunning ? 'ok' : 'error'],
    ['healthz', text(health.status, '未知'), health.status === 'ok' ? 'ok' : 'warn'],
    ['OpenClaw', gatewayOnline ? 'Gateway 在线' : '未检测到在线 Agent', gatewayOnline ? 'ok' : 'warn'],
    ['自动派发', runtime.autoDispatchEnabled ? '已开启' : '已关闭（手动模式）', runtime.autoDispatchEnabled ? 'warn' : 'ok'],
  ]
  els.runtime.innerHTML = items.map(([label, value, cls]) => `<div class="runtime-item"><span class="runtime-label">${escape(label)}</span><strong class="runtime-value ${cls}">${escape(value)}</strong></div>`).join('')
}

function renderTasks() {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  const active = Array.isArray(snapshot?.activeTasks) ? snapshot.activeTasks : []
  const ordered = [...active, ...tasks.filter((task) => !active.some((item) => item.id === task.id))]
  els.taskCount.textContent = String(active.length)
  if (!ordered.length) {
    els.taskList.innerHTML = '<div class="empty-list">当前没有任务记录</div>'
    return
  }
  els.taskList.innerHTML = ordered.map((task) => `
    <button class="task-item ${task.id === selectedTaskId ? 'selected' : ''}" data-task-id="${escape(task.id)}" type="button">
      <span class="task-item-row"><span class="task-id">${escape(task.id)}</span><span class="state-badge ${stateClass(task.state)}">${escape(stateLabel(task.state))}</span></span>
      <span class="task-title">${escape(task.title || task.now || '未命名任务')}</span>
      <span class="task-meta"><span>${escape(task.org || '未分配部门')}</span><span>${escape(task.official || '未分配 Agent')}</span></span>
    </button>
  `).join('')
  els.taskList.querySelectorAll('[data-task-id]').forEach((button) => button.addEventListener('click', () => {
    selectedTaskId = button.dataset.taskId || ''
    renderTasks()
    renderDetail()
  }))
  if (!selectedTaskId || !ordered.some((task) => task.id === selectedTaskId)) {
    selectedTaskId = active[0]?.id || ordered[0]?.id || ''
    renderTasks()
    renderDetail()
  }
}

function renderDetail() {
  const task = (snapshot?.tasks || []).find((item) => item.id === selectedTaskId)
  if (!task) {
    els.detailTitle.textContent = '选择一个任务'
    els.detailMeta.textContent = '任务的 Agent、部门、阶段和活动会显示在这里。'
    els.detailState.className = 'state-badge neutral'
    els.detailState.textContent = '未选择'
    els.detailBody.className = 'detail-body empty-detail'
    els.detailBody.textContent = '暂无任务详情'
    els.taskActions.hidden = true
    return
  }
  const activity = snapshot?.taskActivities?.[task.id]
  const scheduler = snapshot?.schedulerStates?.[task.id]
  const flow = Array.isArray(task.flow_log) ? task.flow_log.slice(-10).reverse() : []
  els.detailTitle.textContent = task.title || task.id
  els.detailMeta.textContent = `${task.id} · ${task.org || '未分配部门'} · ${task.official || '未分配 Agent'} · 当前阶段 ${stateLabel(task.state)}`
  els.detailState.className = `state-badge ${stateClass(task.state)}`
  els.detailState.textContent = stateLabel(task.state)
  els.detailBody.className = 'detail-body'
  els.detailBody.innerHTML = `
    <div class="detail-section"><div class="detail-label">当前回奏</div><div class="detail-value">${escape(task.now || '暂无')}</div></div>
    <div class="detail-section"><div class="detail-label">子任务 / 验收</div><div class="detail-value">${escape(task.ac || '暂无验收标准')}</div></div>
    <div class="detail-section"><div class="detail-label">调度器状态</div><pre class="code-block">${escape(jsonPreview(scheduler || { status: '暂无记录' }))}</pre></div>
    <div class="detail-section"><div class="detail-label">工具调用与活动日志</div><pre class="code-block">${escape(jsonPreview(activity || { activity: '暂无活动记录' }))}</pre></div>
    <div class="detail-section"><div class="detail-label">流程轨迹</div><div class="flow-list">${flow.length ? flow.map((entry) => `<div class="flow-entry"><time>${escape(entry.at || '')}</time>${escape(entry.remark || `${entry.from || ''} → ${entry.to || ''}`)}</div>`).join('') : '<div class="muted">暂无流程轨迹</div>'}</div></div>
  `
  els.taskActions.hidden = false
}

function renderAgents() {
  const agents = Array.isArray(snapshot?.agentsStatus?.agents) ? snapshot.agentsStatus.agents : []
  if (!agents.length) {
    els.agents.innerHTML = '<div class="empty-list">暂无 Agent 状态</div>'
    return
  }
  els.agents.innerHTML = agents.map((agent) => `<div class="agent-item"><span class="agent-name">${escape(agent.label || agent.name || agent.id)}</span><span class="agent-status ${escape(agent.status || 'idle')}">${escape(agent.statusLabel || agent.status || '未知')}</span></div>`).join('')
}

function renderErrors() {
  const errors = Array.isArray(snapshot?.recentErrors) ? snapshot.recentErrors : (snapshot?.errors || []).map((error) => `${error.endpoint}: ${error.message}`)
  if (!errors.length) {
    els.errors.innerHTML = '<div class="empty-list">最近没有错误</div>'
    return
  }
  els.errors.innerHTML = errors.slice(0, 20).map((error) => `<div class="error-item"><strong>诊断</strong> ${escape(error)}</div>`).join('')
}

function render() {
  renderRuntime()
  renderTasks()
  renderAgents()
  renderErrors()
  els.updated.textContent = snapshot?.checkedAt ? `最近更新：${new Date(snapshot.checkedAt).toLocaleString()}` : '尚未读取到状态'
}

async function refresh() {
  if (loading) return
  loading = true
  try {
    snapshot = await api.getObservability({ includeOutputs: false, maxTrackedTasks: 12 })
    render()
  } catch (error) {
    snapshot = { runtime: {}, tasks: [], activeTasks: [], errors: [String(error)] }
    render()
  } finally {
    loading = false
  }
}

function buildTaskActionRequest(action, taskId) {
  const pathByAction = {
    archive: '/api/archive-task',
    retry: '/api/scheduler-retry',
    escalate: '/api/scheduler-escalate',
    rollback: '/api/scheduler-rollback',
  }
  const path = pathByAction[action] || '/api/task-action'
  const body = ['stop', 'cancel', 'resume'].includes(action)
    ? { taskId, action, reason: 'Edict 执行监控操作' }
    : action === 'archive'
      ? { taskId, archived: true }
      : { taskId, reason: 'Edict 执行监控操作' }
  return { path, method: 'POST', body }
}

els.taskActions.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', async () => {
  if (!selectedTaskId) return
  button.disabled = true
  try {
    await api.dashboardApi(buildTaskActionRequest(button.dataset.action || '', selectedTaskId))
    await refresh()
  } catch (error) {
    els.errors.insertAdjacentHTML('afterbegin', `<div class="error-item"><strong>操作失败</strong> ${escape(error instanceof Error ? error.message : error)}</div>`)
  } finally {
    button.disabled = false
  }
}))

document.querySelector('#refresh').addEventListener('click', refresh)
document.querySelector('#settings').addEventListener('click', () => api.openSettings())
document.querySelector('#dashboard').addEventListener('click', () => api.openDashboard())

await refresh()
setInterval(refresh, 2000)
