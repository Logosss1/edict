const api = window.edictDesktop

const els = {
  title: document.querySelector('#title'),
  message: document.querySelector('#message'),
  details: document.querySelector('#details'),
  progress: document.querySelector('#progress'),
  retry: document.querySelector('#retry'),
  settings: document.querySelector('#settings'),
}

function render(state) {
  const status = state?.startupState || 'starting'
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
    render(await api.getDiagnostics())
  } catch (error) {
    els.details.textContent = error instanceof Error ? error.message : String(error)
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

await refresh()
setInterval(refresh, 500)
