const api = window.edictDesktop

const els = {
  title: document.querySelector('#title'),
  message: document.querySelector('#message'),
  details: document.querySelector('#details'),
  progress: document.querySelector('#progress'),
  retry: document.querySelector('#retry'),
  settings: document.querySelector('#settings'),
  workspaceSetup: document.querySelector('#workspace-setup'),
  workspaceCurrent: document.querySelector('#workspace-current'),
  projectSetup: document.querySelector('#project-setup'),
  workspaceError: document.querySelector('#workspace-error'),
  createWorkspace: document.querySelector('#create-workspace'),
  selectWorkspace: document.querySelector('#select-workspace'),
  useWorkspaceProject: document.querySelector('#use-workspace-project'),
  selectProject: document.querySelector('#select-project'),
}

function setBusy(busy) {
  for (const button of [els.createWorkspace, els.selectWorkspace, els.useWorkspaceProject, els.selectProject]) {
    button.disabled = busy
  }
}

function showSetupError(error) {
  els.workspaceError.hidden = !error
  els.workspaceError.textContent = error || ''
}

function render(state, workspaceState) {
  const status = state?.startupState || 'starting'
  const workspace = workspaceState?.activeWorkspace || state?.workspace || null
  const needsWorkspace = !workspace
  const needsProject = Boolean(workspace && !workspace.projectPath)
  const needsSetup = needsWorkspace || needsProject
  els.workspaceSetup.hidden = !needsSetup
  els.projectSetup.hidden = !needsProject
  els.workspaceCurrent.hidden = !workspace
  els.workspaceCurrent.textContent = workspace ? `当前工作区：${workspace.name}\n${workspace.path}` : ''
  els.createWorkspace.hidden = !needsWorkspace
  els.selectWorkspace.hidden = !needsWorkspace
  if (needsWorkspace) {
    els.title.textContent = '先创建一个工作区'
    els.message.textContent = '选择或创建文件夹后，才能进入三省六部工作台。'
    els.progress.style.width = '12%'
    els.details.textContent = '工作区是任务、Agent 记忆与项目上下文的隔离边界。'
    els.retry.hidden = true
    return
  }
  if (needsProject) {
    els.title.textContent = '再选择一个项目'
    els.message.textContent = '工作区已就绪，请确认本次任务要操作的项目目录。'
    els.progress.style.width = '28%'
    els.details.textContent = `工作区：${workspace.path}`
    els.retry.hidden = true
    return
  }
  if (status === 'ready') {
    els.title.textContent = '正在打开总控台'
    els.message.textContent = '原始 EDICT 看板已就绪。'
    els.progress.style.width = '100%'
    els.retry.hidden = true
    return
  }
  if (status === 'error' || status === 'crashed') {
    els.title.textContent = status === 'crashed' ? '看板进程已停止' : 'EDICT 启动失败'
    els.message.textContent = '可以重试启动，或先打开设置查看运行诊断。'
    els.details.textContent = state.startupError || '未提供错误详情'
    els.progress.style.width = '0%'
    els.retry.hidden = false
    return
  }
  els.title.textContent = '正在启动三省六部总控台'
  els.message.textContent = '正在准备本地运行环境和原始 EDICT 看板…'
  els.details.textContent = state?.dataDirectory ? `数据目录：${state.dataDirectory}` : ''
  els.progress.style.width = '55%'
  els.retry.hidden = true
}

async function refresh() {
  try {
    const [diagnostics, workspaceState] = await Promise.all([api.getDiagnostics(), api.getWorkspaceState()])
    render(diagnostics, workspaceState)
  } catch (error) {
    els.details.textContent = error instanceof Error ? error.message : String(error)
  }
}

async function chooseWorkspace(mode) {
  showSetupError('')
  setBusy(true)
  try {
    const result = await api.chooseWorkspace(mode)
    if (result?.error) throw new Error(result.error)
    await refresh()
  } catch (error) {
    showSetupError(error instanceof Error ? error.message : String(error))
  } finally {
    setBusy(false)
  }
}

async function chooseProject(useWorkspace) {
  showSetupError('')
  setBusy(true)
  try {
    const result = useWorkspace ? await api.useWorkspaceAsProject() : await api.chooseProject()
    if (result?.error) throw new Error(result.error)
    await refresh()
  } catch (error) {
    if (!/Execution context was destroyed/.test(String(error))) {
      showSetupError(error instanceof Error ? error.message : String(error))
    }
  } finally {
    setBusy(false)
  }
}

els.retry.addEventListener('click', async () => {
  els.retry.disabled = true
  els.message.textContent = '正在重试…'
  await api.retryDashboard()
  els.retry.disabled = false
  await refresh()
})

els.settings.addEventListener('click', () => api.openSettings())
els.createWorkspace.addEventListener('click', () => chooseWorkspace('create'))
els.selectWorkspace.addEventListener('click', () => chooseWorkspace('existing'))
els.useWorkspaceProject.addEventListener('click', () => chooseProject(true))
els.selectProject.addEventListener('click', () => chooseProject(false))

await refresh()
setInterval(refresh, 500)
