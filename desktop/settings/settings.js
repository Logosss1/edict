const api = window.edictDesktop

const $ = (selector) => document.querySelector(selector)
const els = {
  tabs: [...document.querySelectorAll('[data-tab]')],
  panels: [...document.querySelectorAll('.tab-panel')],
  list: $('#provider-list'), empty: $('#empty-providers'), form: $('#provider-form'),
  title: $('#editor-title'), status: $('#provider-status'), id: $('#provider-id'), idPreview: $('#provider-id-preview'),
  name: $('#provider-name'), type: $('#provider-type'), url: $('#provider-url'), key: $('#provider-key'), keyHint: $('#key-hint'),
  models: $('#provider-models'), defaultModel: $('#provider-default-model'), error: $('#form-error'), success: $('#form-success'),
  testMeta: $('#provider-test-meta'),
  remove: $('#remove-provider'), diagnostics: $('#diagnostics'),
  agentList: $('#agent-list'), agentCount: $('#agent-count'), agentTitle: $('#agent-title'), agentMeta: $('#agent-meta'), agentStatus: $('#agent-status'),
  agentProvider: $('#agent-provider'), agentModel: $('#agent-model'), agentBinding: $('#agent-binding'), agentThinking: $('#agent-thinking'), agentToolProfile: $('#agent-tool-profile'),
  agentSkills: $('#agent-skills'), agentAllowAgents: $('#agent-allow-agents'), agentSandboxMode: $('#agent-sandbox-mode'), agentWorkspaceAccess: $('#agent-workspace-access'),
  agentError: $('#agent-form-error'), agentSuccess: $('#agent-form-success'), skillName: $('#skill-name'), skillTrigger: $('#skill-trigger'), skillDescription: $('#skill-description'),
  globalProvider: $('#global-provider'), globalModel: $('#global-model'), globalThinking: $('#global-thinking'), globalToolProfile: $('#global-tool-profile'),
  networkSearch: $('#network-search'), networkFetch: $('#network-fetch'), autoDispatch: $('#auto-dispatch'), gatewayRestart: $('#gateway-restart'), runtimeStatus: $('#runtime-status'),
  runtimeError: $('#runtime-error'), runtimeSuccess: $('#runtime-success'),
  mcpList: $('#mcp-list'), emptyMcp: $('#empty-mcp'), mcpCount: $('#mcp-count'), mcpTitle: $('#mcp-title'), mcpStatus: $('#mcp-status'), mcpForm: $('#mcp-form'),
  mcpName: $('#mcp-name'), mcpTransport: $('#mcp-transport'), mcpJson: $('#mcp-json'), mcpError: $('#mcp-error'), mcpSuccess: $('#mcp-success'), removeMcp: $('#remove-mcp'),
  opsSummary: $('#ops-summary'), opsErrors: $('#ops-errors'), opsTasks: $('#ops-tasks'), opsJson: $('#ops-json'), reloadDashboard: $('#reload-dashboard'),
}

let providers = []
let selectedProviderId = ''
let agentBindings = []
let configSnapshot = null
let selectedAgentId = ''
let selectedMcpName = ''
let lastDiagnostics = null
let modelCapabilities = []
let capabilityAgents = []
let capabilityError = ''
let discoveredModels = null
let providerFormRevision = 0

const BUILTIN_PROVIDER_IDS = new Set(['anthropic', 'openai', 'openai-codex', 'google', 'copilot', 'github-copilot'])

function isCustomModelReference(model) {
  const value = String(model || '').trim()
  if (!value || value === 'unknown') return false
  const separator = value.indexOf('/')
  return separator <= 0 || !BUILTIN_PROVIDER_IDS.has(value.slice(0, separator).toLowerCase())
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]))
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function setMessage(error = '', success = '') {
  els.error.textContent = error
  els.success.textContent = success
}

function setStatus(element, kind, text) {
  element.className = `status-dot ${kind}`
  element.textContent = text
}

function setProviderTestMeta(kind = '', title = '', detail = '') {
  if (!els.testMeta) return
  els.testMeta.hidden = !kind
  els.testMeta.className = `provider-test-meta${kind ? ` ${kind}` : ''}`
  els.testMeta.replaceChildren()
  if (!kind) return
  const heading = document.createElement('strong')
  heading.textContent = title
  els.testMeta.appendChild(heading)
  if (detail) {
    const details = document.createElement('span')
    details.textContent = detail
    els.testMeta.appendChild(details)
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function switchTab(name) {
  els.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name))
  els.panels.forEach((panel) => { panel.hidden = panel.id !== `tab-${name}` })
  if (name === 'agents') void loadAgents()
  if (name === 'runtime') void loadConfig()
  if (name === 'mcp') void loadConfig()
  if (name === 'ops') void loadOps()
  if (name === 'dependencies') void checkDependencies()
}

els.tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)))
api.onSettingsTab?.(tab => { if (tab === 'dependencies') switchTab(tab) })

let dependenciesBusy = false
let dependenciesLoaded = false
async function checkDependencies(paths) {
  if (dependenciesBusy) return
  dependenciesBusy = true
  $('#dependencies-error').textContent = ''
  setStatus($('#dependencies-status'), 'neutral', '检测中…')
  $('#dependencies-form').querySelectorAll('button, input').forEach(el => { el.disabled = true })
  try {
    const result = paths ? await api.saveRuntimePaths(paths) : await api.checkRuntime()
    if (!dependenciesLoaded) {
      $('#openclaw-path').value = result.overrides?.openclawPath || ''
      $('#node-path').value = result.overrides?.nodePath || ''
      dependenciesLoaded = true
    }
    setStatus($('#dependencies-status'), result.ok ? 'ok' : 'error', result.ok ? '已就绪' : '需要修复')
    $('#dependencies-result').textContent = [
      `OpenClaw${result.openclawVersion ? ` ${result.openclawVersion}` : ''}：${result.openclawPath || '未找到'}`,
      `Node.js${result.nodeVersion ? ` ${result.nodeVersion}` : ''}：${result.nodePath || '未找到'}`,
      ...(paths ? ['路径已保存，后续调用生效；正在运行的任务不受影响。'] : []),
    ].join('\n')
    $('#dependencies-error').textContent = (result.errors || []).join(' ')
    if (!result.ok && paths) $('#dependencies-error').focus()
  } catch (error) {
    setStatus($('#dependencies-status'), 'error', '检测失败')
    $('#dependencies-error').textContent = errorText(error)
  } finally {
    dependenciesBusy = false
    $('#dependencies-form').querySelectorAll('button, input').forEach(el => { el.disabled = false })
  }
}
$('#dependencies-form').addEventListener('submit', event => {
  event.preventDefault()
  void checkDependencies({ openclawPath: $('#openclaw-path').value, nodePath: $('#node-path').value })
})
$('#check-dependencies').addEventListener('click', () => void checkDependencies())
$('#auto-dependencies').addEventListener('click', () => {
  $('#openclaw-path').value = ''; $('#node-path').value = ''
  void checkDependencies({ openclawPath: '', nodePath: '' })
})
document.querySelectorAll('[data-select-path]').forEach(button => button.addEventListener('click', async () => {
  try {
    const selected = await api.selectRuntimePath(button.dataset.selectPath)
    if (selected) $(button.dataset.selectPath === 'nodePath' ? '#node-path' : '#openclaw-path').value = selected
  } catch (error) { $('#dependencies-error').textContent = errorText(error) }
}))

function clearDiscoveredModels() {
  discoveredModels = null
  providerFormRevision += 1
}

function resetProviderForm() {
  clearDiscoveredModels()
  selectedProviderId = ''
  els.form.reset(); els.id.value = ''; els.idPreview.value = ''
  els.title.textContent = '新增供应商'; els.remove.hidden = true
  els.keyHint.textContent = '保存后只显示“已设置”，不会回显原密钥。'
  setStatus(els.status, 'neutral', '未保存'); setProviderTestMeta(); setMessage()
}

function fillProviderForm(provider) {
  clearDiscoveredModels()
  selectedProviderId = provider.id
  els.id.value = provider.id; els.idPreview.value = provider.id; els.name.value = provider.name || ''
  els.type.value = provider.type || 'openai-compatible'; els.url.value = provider.baseUrl || ''; els.key.value = ''
  els.models.value = (provider.models || []).join('\n'); els.defaultModel.value = provider.defaultModel || provider.defaultModelId || ''
  els.title.textContent = `编辑 · ${provider.name || provider.id}`; els.remove.hidden = false
  els.keyHint.textContent = provider.secretStored ? '密钥已安全保存；留空表示继续使用现有密钥。' : '尚未设置密钥。'
  setStatus(els.status, provider.secretStored ? 'ok' : 'neutral', provider.secretStored ? '密钥已设置' : '待设置密钥'); setProviderTestMeta(); setMessage()
}

function renderProviderList() {
  els.list.innerHTML = providers.map((provider) => `<button class="provider-item ${provider.id === selectedProviderId ? 'active' : ''}" data-provider-id="${escapeHtml(provider.id)}" type="button"><span class="provider-name">${escapeHtml(provider.name || provider.id)}</span><span class="provider-meta">${escapeHtml(provider.baseUrl)} · ${provider.models?.length || 0} 个模型</span></button>`).join('')
  els.empty.hidden = providers.length > 0
  els.list.querySelectorAll('[data-provider-id]').forEach((button) => button.addEventListener('click', () => {
    const provider = providers.find((item) => item.id === button.dataset.providerId)
    if (provider) { fillProviderForm(provider); renderProviderList() }
  }))
}

async function loadProviders() {
  providers = await api.listProviders()
  renderProviderList()
  populateProviderSelect(els.agentProvider, els.agentProvider?.value)
  populateProviderSelect(els.globalProvider, els.globalProvider?.value)
}

function formPayload() {
  const baseUrl = els.url.value.trim()
  const definitions = discoveredModels?.providerId === selectedProviderId && discoveredModels.baseUrl === baseUrl && discoveredModels.type === els.type.value
    ? discoveredModels.definitions : []
  return {
    id: els.id.value.trim() || undefined, name: els.name.value.trim(), type: els.type.value, baseUrl,
    apiKey: els.key.value, models: lines(els.models.value).map(id => definitions.find(model => model.id === id) || id),
    defaultModelId: els.defaultModel.value.trim() || undefined,
  }
}

[els.url, els.type, els.key].forEach(input => input.addEventListener('input', clearDiscoveredModels))

els.form.addEventListener('submit', async (event) => {
  event.preventDefault(); setMessage()
  const payload = formPayload()
  if (!payload.name || !payload.baseUrl) { setMessage('请填写显示名称和 Base URL。'); return }
  try {
    const saved = await api.saveProvider(payload)
    selectedProviderId = saved.id
    await loadProviders(); const provider = providers.find((item) => item.id === selectedProviderId)
    if (provider) fillProviderForm(provider)
    const integration = saved.integration
    setMessage('', integration && integration.ok === false ? `供应商已保存，但 OpenClaw 同步失败：${integration.error || '未知错误'}` : '供应商已保存，并已同步到 OpenClaw 模型目录。')
  } catch (error) { setMessage(errorText(error)); setStatus(els.status, 'error', '保存失败') }
})

$('#new-provider').addEventListener('click', () => { resetProviderForm(); renderProviderList(); els.name.focus() })
$('#preset-example-provider').addEventListener('click', () => {
  clearDiscoveredModels()
  if (!els.name.value) els.name.value = '示例供应商 测试'
  els.url.value = 'https://api.example.com/v1'; els.type.value = 'openai-compatible'
  setMessage('', '已填入测试供应商模板；请粘贴测试密钥后保存或直接测试。')
})
$('#test-provider').addEventListener('click', async () => {
  setMessage(); const payload = formPayload()
  if (!payload.baseUrl) { setProviderTestMeta(); setMessage('请先填写 Base URL。'); return }
  clearDiscoveredModels()
  const revision = providerFormRevision
  const providerId = selectedProviderId
  setProviderTestMeta('testing', '正在测试连接…')
  const button = $('#test-provider'); button.disabled = true; button.textContent = '测试中…'
  try {
    const result = await api.testProvider(payload)
    if (revision !== providerFormRevision) return
    const detail = [
      Number.isFinite(result?.status) ? `HTTP ${result.status}` : '',
      Number.isFinite(result?.latencyMs) ? `延迟 ${result.latencyMs} ms` : '',
      Number.isFinite(result?.modelCount) ? `模型 ${result.modelCount} 个` : '',
      result?.endpoint || '',
      result?.error || '',
    ].filter(Boolean).join(' · ')
    if (result?.ok) {
      discoveredModels = {
        providerId, baseUrl: payload.baseUrl, type: payload.type,
        definitions: (Array.isArray(result.modelDefinitions) ? result.modelDefinitions : [])
          .filter(model => model && typeof model.id === 'string')
          .map(model => ({
            id: model.id,
            ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
            ...(Array.isArray(model.supportedReasoningEfforts) ? {
              supportedReasoningEfforts: model.supportedReasoningEfforts.filter(level => typeof level === 'string'),
            } : {}),
          })),
      }
      setStatus(els.status, 'ok', '连接成功')
      setProviderTestMeta('ok', '供应商连接正常', detail || '请求已完成。')
      setMessage('', `连接成功${Number.isFinite(result.modelCount) ? `，发现 ${result.modelCount} 个模型` : ''}。${Number.isFinite(result.latencyMs) ? `延迟 ${result.latencyMs} ms。` : ''}`)
      if (Array.isArray(result.models) && result.models.length && !els.models.value.trim()) els.models.value = result.models.join('\n')
    } else {
      setStatus(els.status, 'error', '连接失败')
      setProviderTestMeta('error', '供应商连接失败', detail || '请检查地址和密钥。')
      setMessage(result?.error || '连接失败，请检查地址和密钥。')
    }
  } catch (error) {
    if (revision !== providerFormRevision) return
    setStatus(els.status, 'error', '连接失败')
    setProviderTestMeta('error', '连接测试失败', errorText(error))
    setMessage(errorText(error))
  }
  finally { button.disabled = false; button.textContent = '测试连接' }
})
els.remove.addEventListener('click', async () => {
  if (!selectedProviderId || !window.confirm('删除此供应商及其安全存储的密钥？')) return
  try { await api.removeProvider(selectedProviderId); resetProviderForm(); await loadProviders() } catch (error) { setMessage(errorText(error)) }
})
$('#open-dashboard').addEventListener('click', () => api.openDashboard())
$('#open-monitor').addEventListener('click', () => api.openMonitor?.())
els.reloadDashboard.addEventListener('click', async () => {
  els.reloadDashboard.disabled = true; els.reloadDashboard.textContent = '重载中…'
  try { await api.reloadDashboard(); await loadDiagnostics(); els.reloadDashboard.hidden = true }
  catch (error) { els.diagnostics.textContent = `看板重载失败：${errorText(error)}` }
  finally { els.reloadDashboard.disabled = false; els.reloadDashboard.textContent = '重载看板' }
})

function populateProviderSelect(select, selected) {
  if (!select) return
  const current = selected || select.value
  select.innerHTML = providers.length ? providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name || provider.id)}</option>`).join('') : '<option value="">暂无供应商</option>'
  if (providers.some((provider) => provider.id === current)) select.value = current
}

function populateModelSelect(select, providerId, selected) {
  if (!select) return
  const provider = providers.find((item) => item.id === providerId)
  const models = provider?.models || []
  const current = isCustomModelReference(selected) ? selected : ''
  select.innerHTML = models.length ? models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('') : '<option value="">暂无模型，请先保存供应商</option>'
  if (current && !models.includes(current) && isCustomModelReference(providerId ? `${providerId}/${current}` : current)) select.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(current)}">${escapeHtml(current)}（当前）</option>`)
  if (current) select.value = current
}

async function loadModelCapabilities() {
  try {
    const result = await api.dashboardApi({ path: '/api/model-capabilities' })
    if (!result?.ok || !Array.isArray(result.models)) throw new Error(result?.error || '模型能力数据不可用')
    modelCapabilities = result.models
    capabilityAgents = Array.isArray(result.agents) ? result.agents : []
    capabilityError = ''
  } catch (error) {
    modelCapabilities = []; capabilityAgents = []; capabilityError = `模型档位读取失败：${errorText(error)}`
  }
  document.querySelectorAll('[data-refresh-capabilities]').forEach(button => { button.hidden = !capabilityError })
}

function boundAgentModel() {
  return capabilityAgents.find(agent => agent.agentId === selectedAgentId)?.model
    || bindingRecord(selectedAgentId)?.model || configSnapshot?.defaultModel || ''
}

function populateThinking(select, model, current, inheritedLabel, details) {
  const capability = modelCapabilities.find(item => item.model === model)
  const levels = [...new Set(['default', ...(capability?.levels || [])])]
  const mapping = capability?.mapping || {}
  const runtimeLevels = capability?.runtimeLevels
  const supported = level => level === 'default' || !Array.isArray(runtimeLevels)
    || runtimeLevels.includes(mapping[level] || (level === 'none' ? 'off' : level))
  let value = String(current || '')
  if (value === 'off' && levels.includes('none')) value = 'none'
  if (value && !levels.includes(value)) value = levels.find(level => mapping[level] === value) || value
  const incompatible = Boolean(value && (!levels.includes(value) || !supported(value)))
  select.innerHTML = `<option value="">${escapeHtml(inheritedLabel)}</option>` + levels.map(level =>
    `<option value="${escapeHtml(level)}"${supported(level) ? '' : ' disabled'}>${escapeHtml(level === 'default' ? '默认（清除显式档位）' : level)}${supported(level) ? '' : '（运行时不支持）'}</option>`
  ).join('')
  if (incompatible && !levels.includes(value)) {
    select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(value)}" disabled>${escapeHtml(value)}（不兼容，待调整）</option>`)
  }
  select.value = value
  const invalid = incompatible ? `当前档位 ${value} 不适用于 ${model || '未绑定模型'}，请选择可用档位。` : ''
  select.setCustomValidity(invalid)
  select.setAttribute('aria-invalid', String(incompatible))
  const source = { catalog: '已知模型定义', official: '已知模型定义', provider: '模型配置声明', manual: '手动声明', unknown: '未确认' }[capability?.source] || capability?.source || '未确认'
  details.textContent = [
    `模型：${model || '未绑定'} · 来源：${source}`,
    capabilityError || (!capability ? '未取得能力信息，仅可清除显式档位或保留继承。' : ''),
    invalid,
    ...(capability?.warnings || []),
    value && value !== 'default' && mapping[value] && mapping[value] !== value ? `选择 → 运行时 → 供应商：${value} → ${mapping[value]} → ${capability?.wireMapping?.[value] ?? value}` : '',
  ].filter(Boolean).join('；')
  details.classList.toggle('capability-error', Boolean(invalid || capabilityError))
}

function renderAgentThinking(value = els.agentThinking.value) {
  populateThinking(els.agentThinking, boundAgentModel(), value, '继承全局', $('#agent-thinking-details'))
}

function renderGlobalThinking(value = els.globalThinking.value) {
  const model = els.globalProvider.value && els.globalModel.value ? `${els.globalProvider.value}/${els.globalModel.value}` : ''
  populateThinking(els.globalThinking, model, value, '不修改', $('#global-thinking-details'))
}

function renderPendingAgentModel() {
  const model = boundAgentModel()
  const pending = els.agentProvider.value && els.agentModel.value ? `${els.agentProvider.value}/${els.agentModel.value}` : ''
  els.agentBinding.textContent = `${model ? `当前：${model}` : '当前未绑定自定义模型'}${pending && pending !== model ? '；所选模型尚未应用，策略仍针对当前模型' : ''}`
}

document.querySelectorAll('[data-manage-capabilities]').forEach(button => {
  button.addEventListener('click', () => typeof api.openModelSettings === 'function' ? api.openModelSettings() : api.openDashboard())
})
document.querySelectorAll('[data-refresh-capabilities]').forEach(button => {
  button.addEventListener('click', async () => {
    button.disabled = true
    try { await loadModelCapabilities(); renderAgentThinking(); renderGlobalThinking() }
    finally { button.disabled = false }
  })
})
els.agentThinking.addEventListener('change', () => renderAgentThinking())
els.globalThinking.addEventListener('change', () => renderGlobalThinking())
els.globalModel.addEventListener('change', () => renderGlobalThinking())

function bindingRecord(agentId) {
  return agentBindings.find((item) => item.agentId === agentId)
}

function configAgent(agentId) {
  return configSnapshot?.agents?.find((item) => item.id === agentId)
}

function renderAgentList() {
  els.agentList.innerHTML = agentBindings.map((binding) => {
    const model = isCustomModelReference(binding.model) ? binding.model : ''
    return `<button class="provider-item ${binding.agentId === selectedAgentId ? 'active' : ''}" data-agent-id="${escapeHtml(binding.agentId)}" type="button"><span class="provider-name">${escapeHtml(binding.label || binding.agentId)}</span><span class="provider-meta">${escapeHtml(binding.agentId)} · ${escapeHtml(model || '未绑定自定义模型')}</span></button>`
  }).join('')
  els.agentCount.textContent = `${agentBindings.length} 个实际注册 Agent（来自 agents.json）`
  els.agentList.querySelectorAll('[data-agent-id]').forEach((button) => button.addEventListener('click', () => { selectedAgentId = button.dataset.agentId; fillAgent(); renderAgentList() }))
}

function fillAgent() {
  const binding = bindingRecord(selectedAgentId); const config = configAgent(selectedAgentId)
  if (!binding) { els.agentTitle.textContent = '选择 Agent'; setStatus(els.agentStatus, 'neutral', '未选择'); return }
  const model = isCustomModelReference(binding.model) ? binding.model : ''
  const providerId = model && binding.providerId && !BUILTIN_PROVIDER_IDS.has(String(binding.providerId).toLowerCase()) ? binding.providerId : providers[0]?.id || ''
  const modelId = model ? (binding.modelId || (model.includes('/') ? model.split('/').slice(1).join('/') : model)) : ''
  els.agentTitle.textContent = binding.label || binding.agentId; els.agentMeta.textContent = `${binding.agentId} · ${binding.workspace || '工作区未声明'}`
  populateProviderSelect(els.agentProvider, providerId); populateModelSelect(els.agentModel, providerId, modelId)
  renderPendingAgentModel()
  renderAgentThinking(config?.thinkingDefault || '')
  els.agentToolProfile.value = config?.tools?.profile || ''
  els.agentSkills.value = (config?.skills || []).join('\n'); els.agentAllowAgents.value = (config?.allowAgents || []).join('\n')
  els.agentSandboxMode.value = config?.sandbox?.mode || ''; els.agentWorkspaceAccess.value = config?.sandbox?.workspaceAccess || ''
  setStatus(els.agentStatus, 'ok', '已读取')
}

async function loadAgents() {
  try {
    const [bindings, snapshot] = await Promise.all([api.getAgentBindings(), api.getOpenClawSnapshot(), loadModelCapabilities()])
    agentBindings = bindings?.agents || []; configSnapshot = snapshot || null
    if (!selectedAgentId || !bindingRecord(selectedAgentId)) selectedAgentId = agentBindings[0]?.agentId || ''
    renderAgentList(); fillAgent(); populateProviderSelect(els.agentProvider, els.agentProvider?.value)
  } catch (error) { els.agentCount.textContent = errorText(error); setStatus(els.agentStatus, 'error', '读取失败') }
}

$('#refresh-agents').addEventListener('click', () => loadAgents())
els.agentProvider.addEventListener('change', () => { populateModelSelect(els.agentModel, els.agentProvider.value, ''); renderPendingAgentModel() })
els.agentModel.addEventListener('change', renderPendingAgentModel)
$('#apply-agent-model').addEventListener('click', async () => {
  if (!selectedAgentId || !els.agentProvider.value || !els.agentModel.value) return
  setStatus(els.agentStatus, 'neutral', '应用中…'); els.agentError.textContent = ''; els.agentSuccess.textContent = ''
  try { const result = await api.setAgentModel({ agentId: selectedAgentId, providerId: els.agentProvider.value, modelId: els.agentModel.value }); setStatus(els.agentStatus, 'ok', '已排队'); els.agentSuccess.textContent = result.message || `${selectedAgentId} 已提交模型变更，原调度器正在应用。`; await new Promise((resolve) => setTimeout(resolve, 700)); await loadAgents() }
  catch (error) { setStatus(els.agentStatus, 'error', '应用失败'); els.agentError.textContent = errorText(error) }
})
$('#set-default-model').addEventListener('click', async () => {
  if (!els.agentProvider.value || !els.agentModel.value) return
  try { const result = await api.patchGlobal({ defaultModel: `${els.agentProvider.value}/${els.agentModel.value}` }); const syncFailed = result?.agentConfigSync && result.agentConfigSync.ok === false; els.agentSuccess.textContent = syncFailed ? `全局默认模型已保存，但看板名册同步失败：${result.agentConfigSync.error || '请重载看板后重试。'}` : '已提交全局默认模型变更。'; if (syncFailed) setStatus(els.agentStatus, 'error', '名册同步失败'); await loadConfig() }
  catch (error) { els.agentError.textContent = errorText(error) }
})
$('#save-agent-policy').addEventListener('click', async () => {
  if (!selectedAgentId) return
  if (!els.agentThinking.reportValidity()) { els.agentError.textContent = els.agentThinking.validationMessage; return }
  try {
    const result = await api.patchAgent({ agentId: selectedAgentId, patch: {
      thinkingDefault: els.agentThinking.value || null,
      skills: lines(els.agentSkills.value).length ? lines(els.agentSkills.value) : null,
      allowAgents: lines(els.agentAllowAgents.value).length ? lines(els.agentAllowAgents.value) : null,
      tools: { profile: els.agentToolProfile.value || null },
      sandbox: { mode: els.agentSandboxMode.value || null, workspaceAccess: els.agentWorkspaceAccess.value || null },
    } })
    const syncFailed = result?.agentConfigSync && result.agentConfigSync.ok === false
    els.agentError.textContent = ''
    els.agentSuccess.textContent = syncFailed
      ? `Agent 策略已保存，但看板名册同步失败：${result.agentConfigSync.error || '请重载看板后重试。'}`
      : 'Agent 策略已通过 OpenClaw 配置校验并保存。'
    if (syncFailed) setStatus(els.agentStatus, 'error', '名册同步失败')
    await loadAgents()
  } catch (error) { els.agentError.textContent = errorText(error) }
})
$('#add-skill').addEventListener('click', async () => {
  if (!selectedAgentId || !els.skillName.value.trim()) { els.agentError.textContent = '请先选择 Agent 并填写 Skill 名称。'; return }
  try {
    const result = await api.dashboardApi({ path: '/api/add-skill', method: 'POST', body: { agentId: selectedAgentId, skillName: els.skillName.value.trim(), description: els.skillDescription.value.trim(), trigger: els.skillTrigger.value.trim() } })
    els.agentError.textContent = ''; els.agentSuccess.textContent = result?.message || 'Skill 已添加到 Agent 工作区。'; els.skillName.value = ''; els.skillDescription.value = ''; els.skillTrigger.value = ''; await loadAgents()
  } catch (error) { els.agentError.textContent = errorText(error) }
})

function modelParts(model) {
  if (!model || !String(model).includes('/')) return { provider: '', id: '' }
  const [provider, ...rest] = String(model).split('/')
  return { provider, id: rest.join('/') }
}

async function loadConfig() {
  try {
    const [snapshot] = await Promise.all([api.getOpenClawSnapshot(), loadModelCapabilities()])
    configSnapshot = snapshot
    const parts = isCustomModelReference(configSnapshot?.defaultModel) ? modelParts(configSnapshot?.defaultModel) : { provider: '', id: '' }
    populateProviderSelect(els.globalProvider, parts.provider || providers[0]?.id)
    populateModelSelect(els.globalModel, els.globalProvider.value, parts.id)
    els.globalProvider.onchange = () => { populateModelSelect(els.globalModel, els.globalProvider.value, ''); renderGlobalThinking() }
    renderGlobalThinking(configSnapshot?.defaultThinking || '')
    els.globalToolProfile.value = configSnapshot?.defaultToolProfile || ''
    els.networkSearch.checked = configSnapshot?.network?.search?.enabled !== false
    els.networkFetch.checked = configSnapshot?.network?.fetch?.enabled !== false
    if (lastDiagnostics) { els.autoDispatch.checked = Boolean(lastDiagnostics.autoDispatchEnabled); els.gatewayRestart.checked = lastDiagnostics.gatewayRestartEnabled === true }
    setStatus(els.runtimeStatus, 'ok', '已读取')
  } catch (error) { setStatus(els.runtimeStatus, 'error', '读取失败'); els.runtimeError.textContent = errorText(error) }
}

$('#runtime-form').addEventListener('submit', async (event) => {
  event.preventDefault(); els.runtimeError.textContent = ''; els.runtimeSuccess.textContent = ''
  if (!els.globalThinking.reportValidity()) { els.runtimeError.textContent = els.globalThinking.validationMessage; return }
  try {
    const patch = { webSearchEnabled: els.networkSearch.checked, webFetchEnabled: els.networkFetch.checked }
    if (els.globalModel.value && els.globalProvider.value) patch.defaultModel = `${els.globalProvider.value}/${els.globalModel.value}`
    if (els.globalThinking.value) patch.defaultThinking = els.globalThinking.value
    if (els.globalToolProfile.value) patch.defaultToolProfile = els.globalToolProfile.value
    await api.patchGlobal(patch)
    if (api.setRuntimeOptions) await api.setRuntimeOptions({ autoDispatch: els.autoDispatch.checked, allowGatewayRestart: els.gatewayRestart.checked })
    els.runtimeSuccess.textContent = '运行策略已保存；如需让看板读取新的供应商环境，请确认任务安全后手动重载。'; await loadConfig(); await loadDiagnostics()
  } catch (error) { els.runtimeError.textContent = errorText(error) }
})

function renderMcpList() {
  const servers = configSnapshot?.mcpServers || []
  els.mcpCount.textContent = `${servers.length} 个 MCP 配置`
  els.emptyMcp.hidden = servers.length > 0
  els.mcpList.innerHTML = servers.map((server) => `<button class="provider-item ${server.name === selectedMcpName ? 'active' : ''}" data-mcp-name="${escapeHtml(server.name)}" type="button"><span class="provider-name">${escapeHtml(server.name)}</span><span class="provider-meta">${server.enabled ? '启用' : '停用'} · ${escapeHtml(server.transport || (server.command ? 'stdio' : 'http'))}</span></button>`).join('')
  els.mcpList.querySelectorAll('[data-mcp-name]').forEach((button) => button.addEventListener('click', () => { selectedMcpName = button.dataset.mcpName; fillMcp(); renderMcpList() }))
}

function resetMcp() {
  selectedMcpName = ''; els.mcpForm.reset(); els.mcpName.value = ''; els.mcpTransport.value = 'stdio'; els.mcpJson.value = ''; els.removeMcp.hidden = true; els.mcpTitle.textContent = '新增 MCP 服务器'; setStatus(els.mcpStatus, 'neutral', '未保存'); els.mcpError.textContent = ''; els.mcpSuccess.textContent = ''
}

function fillMcp() {
  const server = (configSnapshot?.mcpServers || []).find((item) => item.name === selectedMcpName)
  if (!server) return resetMcp()
  els.mcpName.value = server.name; els.mcpTransport.value = server.transport || (server.command ? 'stdio' : 'streamable-http'); els.removeMcp.hidden = false; els.mcpTitle.textContent = `编辑 · ${server.name}`
  const safe = { enabled: server.enabled, transport: server.transport, ...(server.command ? { command: server.command } : {}), ...(server.args ? { args: server.args } : {}), ...(server.cwd ? { cwd: server.cwd } : {}), ...(server.url ? { url: server.url } : {}), ...(server.timeout ? { timeout: server.timeout } : {}), ...(server.connectTimeout ? { connectTimeout: server.connectTimeout } : {}), ...(server.toolFilter ? { toolFilter: server.toolFilter } : {}) }
  els.mcpJson.value = JSON.stringify(safe, null, 2); setStatus(els.mcpStatus, server.enabled ? 'ok' : 'neutral', server.enabled ? '已启用' : '已停用')
}

$('#new-mcp').addEventListener('click', () => { resetMcp(); els.mcpName.focus() })
els.mcpForm.addEventListener('submit', async (event) => {
  event.preventDefault(); els.mcpError.textContent = ''; els.mcpSuccess.textContent = ''
  try {
    const config = JSON.parse(els.mcpJson.value || '{}'); config.transport = els.mcpTransport.value
    await api.upsertMcp({ name: els.mcpName.value.trim(), config }); selectedMcpName = els.mcpName.value.trim(); await api.reloadMcp(); await loadConfig(); renderMcpList(); fillMcp(); els.mcpSuccess.textContent = 'MCP 已保存并请求 OpenClaw 重新加载。'
  } catch (error) { els.mcpError.textContent = errorText(error); setStatus(els.mcpStatus, 'error', '保存失败') }
})
els.removeMcp.addEventListener('click', async () => { if (!selectedMcpName || !window.confirm(`删除 MCP ${selectedMcpName}？`)) return; try { await api.removeMcp(selectedMcpName); await api.reloadMcp(); resetMcp(); await loadConfig(); renderMcpList() } catch (error) { els.mcpError.textContent = errorText(error) } })
$('#reload-mcp').addEventListener('click', async () => { try { await api.reloadMcp(); els.mcpSuccess.textContent = 'MCP 缓存已清理，下一个 Agent 回合将读取新配置。' } catch (error) { els.mcpError.textContent = errorText(error) } })

function renderOps(snapshot) {
  const active = snapshot?.activeTasks || []
  const agentData = snapshot?.agentsStatus?.agents || []
  const runningAgents = agentData.filter((item) => item.status === 'running').length
  els.opsSummary.innerHTML = `<span class="metric"><b>${active.length}</b> 当前任务</span><span class="metric"><b>${runningAgents}</b> 运行 Agent</span><span class="metric"><b>${snapshot?.runtime?.dashboardPid || '—'}</b> Python PID</span><span class="metric"><b>${snapshot?.health?.status || '—'}</b> healthz</span>`
  els.opsErrors.textContent = (snapshot?.recentErrors || []).join('；')
  els.opsTasks.innerHTML = active.length ? active.map((task) => {
    const activity = snapshot.taskActivities?.[task.id]; const scheduler = snapshot.schedulerStates?.[task.id]
    const stalled = scheduler && typeof scheduler.stalledSec === 'number' ? `停滞 ${scheduler.stalledSec}s` : ''
    return `<article class="task-row"><div class="task-row-main"><strong>${escapeHtml(task.title || task.id)}</strong><span>${escapeHtml(task.id)} · ${escapeHtml(task.org || '')} · ${escapeHtml(task.state || '')}</span><small>${escapeHtml(task.now || task.block || '暂无最新活动')} ${escapeHtml(stalled)}</small></div><div class="task-row-meta"><span>${Array.isArray(activity?.activity) ? activity.activity.length : 0} 活动</span><button class="mini-action" data-task-action="stop" data-task-id="${escapeHtml(task.id)}" type="button">暂停</button><button class="mini-action" data-task-action="cancel" data-task-id="${escapeHtml(task.id)}" type="button">取消</button></div></article>`
  }).join('') : '<div class="empty-state">没有正在执行的任务</div>'
  els.opsTasks.querySelectorAll('[data-task-action]').forEach((button) => button.addEventListener('click', async () => {
    try { await api.dashboardApi({ path: '/api/task-action', method: 'POST', body: { taskId: button.dataset.taskId, action: button.dataset.taskAction, reason: 'Edict 桌面诊断面板操作' } }); await loadOps() } catch (error) { els.opsErrors.textContent = errorText(error) }
  }))
  els.opsJson.textContent = JSON.stringify({ checkedAt: snapshot?.checkedAt, runtime: snapshot?.runtime, currentTask: snapshot?.currentTask, errors: snapshot?.errors }, null, 2)
}

async function loadOps() {
  try { renderOps(await api.getObservability({ maxTrackedTasks: 8, includeOutputs: false })) } catch (error) { els.opsErrors.textContent = errorText(error) }
}

async function loadDiagnostics() {
  try {
    lastDiagnostics = await api.getDiagnostics()
    els.diagnostics.textContent = `看板 ${lastDiagnostics.dashboardRunning ? '运行中' : '未运行'} · Python PID ${lastDiagnostics.dashboardPid || '—'} · ${lastDiagnostics.dashboardUrl || '尚未分配地址'} · OpenClaw ${lastDiagnostics.openclawConfig || '未配置'}`
    els.reloadDashboard.hidden = !lastDiagnostics.dashboardReloadRequired
    if (document.querySelector('#tab-runtime').hidden === false) { els.autoDispatch.checked = Boolean(lastDiagnostics.autoDispatchEnabled); els.gatewayRestart.checked = lastDiagnostics.gatewayRestartEnabled === true }
  } catch { els.diagnostics.textContent = '无法读取桌面运行状态' }
}

resetProviderForm(); resetMcp()
await loadProviders(); await loadDiagnostics(); await loadConfig(); await loadAgents()
setInterval(loadDiagnostics, 3_000)

