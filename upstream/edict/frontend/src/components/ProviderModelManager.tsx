import { Eye, EyeOff, ExternalLink, KeyRound, LoaderCircle, Plus, RefreshCw, Search, Server, Save, Timer, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export interface ManagedProvider {
  id: string
  name: string
  type?: string
  baseUrl: string
  models: string[]
  modelDefinitions?: ModelDefinition[]
  defaultModel?: string
  secretStored: boolean
  enabled?: boolean
}

interface ModelDefinition { id: string; reasoning?: boolean; supportedReasoningEfforts?: string[] }
interface ProviderDraft {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string
  defaultModel: string
}

interface ProviderPayload {
  id?: string
  name: string
  type: 'openai-compatible'
  baseUrl: string
  apiKey?: string
  models: Array<string | ModelDefinition>
  defaultModelId?: string
}

interface DiscoveryResult {
  ok: boolean
  models?: string[]
  modelDefinitions?: ModelDefinition[]
  modelCount?: number
  endpoint?: string
  status?: number
  latencyMs?: number
  error?: string
}

interface SavedProvider extends ManagedProvider {
  integration?: { ok?: boolean; error?: string }
}

interface DesktopBridge {
  listProviders: () => Promise<ManagedProvider[]>
  saveProvider: (payload: ProviderPayload) => Promise<SavedProvider>
  testProvider: (payload: ProviderPayload) => Promise<DiscoveryResult>
  openSettings?: () => Promise<unknown>
}

interface ProviderModelManagerProps {
  onProvidersChange: (providers: ManagedProvider[]) => void
}

const EMPTY_DRAFT: ProviderDraft = {
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  models: '',
  defaultModel: '',
}

function desktopBridge(): DesktopBridge | undefined {
  return (window as Window & { edictDesktop?: DesktopBridge }).edictDesktop
}

function parseLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function draftFromProvider(provider: ManagedProvider): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name || provider.id,
    baseUrl: provider.baseUrl || '',
    apiKey: '',
    models: provider.models.join('\n'),
    defaultModel: provider.defaultModel || '',
  }
}

function providerPayload(draft: ProviderDraft): ProviderPayload {
  const apiKey = draft.apiKey.trim()
  const defaultModel = draft.defaultModel.trim()
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    type: 'openai-compatible',
    baseUrl: draft.baseUrl.trim(),
    ...(apiKey ? { apiKey } : {}),
    models: parseLines(draft.models),
    ...(defaultModel ? { defaultModelId: defaultModel } : {}),
  }
}

function mergeProviders(current: ManagedProvider[], next: ManagedProvider): ManagedProvider[] {
  const found = current.some((provider) => provider.id === next.id)
  return found
    ? current.map((provider) => (provider.id === next.id ? next : provider))
    : [...current, next]
}

export default function ProviderModelManager({ onProvidersChange }: ProviderModelManagerProps) {
  const connectionRevision = useRef(0)
  const [providers, setProviders] = useState<ManagedProvider[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT)
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([])
  const [discoveredDefinitions, setDiscoveredDefinitions] = useState<ModelDefinition[]>([])
  const [discoveryMeta, setDiscoveryMeta] = useState<{ endpoint?: string; status?: number; latencyMs?: number }>({})
  const [connectionTest, setConnectionTest] = useState<{
    state: 'idle' | 'testing' | 'success' | 'error'
    endpoint?: string
    status?: number
    latencyMs?: number
    modelCount?: number
    error?: string
  }>({ state: 'idle' })
  const [busy, setBusy] = useState<'load' | 'discover' | 'test' | 'save' | ''>('')
  const [showKey, setShowKey] = useState(false)
  const [manualModel, setManualModel] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [bridgeAvailable, setBridgeAvailable] = useState(true)

  const updateProviders = (next: ManagedProvider[]) => {
    setProviders(next)
    onProvidersChange(next)
  }

  const selectProvider = (provider: ManagedProvider) => {
    connectionRevision.current += 1
    setSelectedProviderId(provider.id)
    setDraft(draftFromProvider(provider))
    setDiscoveredModels([])
    setDiscoveredDefinitions([])
    setDiscoveryMeta({})
    setConnectionTest({ state: 'idle' })
    setMessage(null)
  }

  const loadProviders = async (preferredId?: string) => {
    const bridge = desktopBridge()
    if (!bridge) {
      setBridgeAvailable(false)
      updateProviders([])
      return
    }
    setBridgeAvailable(true)
    setBusy('load')
    try {
      const next = await bridge.listProviders()
      updateProviders(next)
      const targetId = preferredId || selectedProviderId
      const target = next.find((provider) => provider.id === targetId) || next[0]
      if (target) selectProvider(target)
      else {
        setSelectedProviderId('')
        setDraft(EMPTY_DRAFT)
      }
    } catch (error) {
      setMessage({ type: 'error', text: '读取供应商失败：' + errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    void loadProviders()
    // Provider data is intentionally loaded once when the model page mounts.
    // The explicit refresh button handles later changes from another window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetDraft = () => {
    connectionRevision.current += 1
    setSelectedProviderId('')
    setDraft(EMPTY_DRAFT)
    setDiscoveredModels([])
    setDiscoveredDefinitions([])
    setDiscoveryMeta({})
    setConnectionTest({ state: 'idle' })
    setManualModel('')
    setMessage(null)
  }

  const updateDraft = (patch: Partial<ProviderDraft>) => {
    if (patch.baseUrl !== undefined || patch.apiKey !== undefined) {
      connectionRevision.current += 1
      setDiscoveredDefinitions([])
      setDiscoveredModels([])
    }
    setDraft((current) => ({ ...current, ...patch }))
    setMessage(null)
  }

  const addManualModel = () => {
    const model = manualModel.trim()
    if (!model) return
    const next = [...parseLines(draft.models), model]
    updateDraft({ models: next.join('\n'), defaultModel: draft.defaultModel || model })
    setManualModel('')
  }

  const setDiscoverySelection = (model: string, selected: boolean) => {
    const current = parseLines(draft.models)
    const next = selected ? [...current, model] : current.filter((item) => item !== model)
    updateDraft({ models: [...new Set(next)].join('\n') })
  }

  const selectAllDiscovered = () => {
    updateDraft({ models: [...new Set([...parseLines(draft.models), ...discoveredModels])].join('\n') })
  }

  const clearDiscovered = () => {
    const discovered = new Set(discoveredModels)
    updateDraft({ models: parseLines(draft.models).filter((model) => !discovered.has(model)).join('\n') })
  }

  const handleTest = async () => {
    const bridge = desktopBridge()
    if (!bridge) {
      setBridgeAvailable(false)
      setMessage({ type: 'error', text: '当前看板没有连接到 Edict 桌面主进程。请从 Edict 应用打开此页面。' })
      return
    }
    if (!draft.baseUrl.trim()) {
      setMessage({ type: 'error', text: '请先填写 Base URL。' })
      return
    }
    setBusy('test')
    setConnectionTest({ state: 'testing' })
    setMessage({ type: 'info', text: '正在测试供应商连接…' })
    try {
      const result = await bridge.testProvider(providerPayload(draft))
      setConnectionTest({
        state: result.ok ? 'success' : 'error',
        endpoint: result.endpoint,
        status: result.status,
        latencyMs: result.latencyMs,
        modelCount: result.modelCount,
        error: result.error,
      })
      const detail = [
        result.status !== undefined ? `HTTP ${result.status}` : '',
        result.latencyMs !== undefined ? `${result.latencyMs} ms` : '',
        result.endpoint || '',
      ].filter(Boolean).join(' · ')
      setMessage({
        type: result.ok ? 'success' : 'error',
        text: result.ok
          ? `连接成功${detail ? `：${detail}` : ''}`
          : `${result.error || '连接失败，请检查地址和 API Key。'}${detail ? `（${detail}）` : ''}`,
      })
    } catch (error) {
      setConnectionTest({ state: 'error', error: errorMessage(error) })
      setMessage({ type: 'error', text: '连接测试失败：' + errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const handleDiscover = async () => {
    const revision = connectionRevision.current
    const bridge = desktopBridge()
    if (!bridge) {
      setBridgeAvailable(false)
      setMessage({ type: 'error', text: '当前看板没有连接到 Edict 桌面主进程。请从 Edict 应用打开此页面。' })
      return
    }
    if (!draft.baseUrl.trim()) {
      setMessage({ type: 'error', text: '请先填写 Base URL。' })
      return
    }
    setBusy('discover')
    setMessage({ type: 'info', text: '正在读取模型目录…' })
    try {
      const result = await bridge.testProvider(providerPayload(draft))
      if (revision !== connectionRevision.current) return
      if (!result.ok) {
        setDiscoveredModels([])
        setMessage({ type: 'error', text: result.error || '模型发现失败，请检查地址和 API Key。' })
        return
      }
      const discovered = [...new Set((result.models || []).map((model) => model.trim()).filter(Boolean))]
      setDiscoveredModels(discovered)
      setDiscoveredDefinitions(result.modelDefinitions || [])
      setDiscoveryMeta({ endpoint: result.endpoint, status: result.status, latencyMs: result.latencyMs })
      const merged = [...new Set([...parseLines(draft.models), ...discovered])]
      updateDraft({
        models: merged.join('\n'),
        defaultModel: draft.defaultModel || discovered[0] || '',
      })
      setMessage({
        type: 'success',
        text: discovered.length
          ? '已发现 ' + (result.modelCount ?? discovered.length) + ' 个模型，并合并到模型列表。保存后会同步到 OpenClaw。'
          : '连接成功，但供应商没有返回模型。你仍可以手动填写模型 ID。',
      })
    } catch (error) {
      setMessage({ type: 'error', text: '模型发现失败：' + errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const bridge = desktopBridge()
    if (!bridge) {
      setBridgeAvailable(false)
      setMessage({ type: 'error', text: '当前看板没有连接到 Edict 桌面主进程。' })
      return
    }
    const models = parseLines(draft.models)
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setMessage({ type: 'error', text: '显示名称和 Base URL 为必填项。' })
      return
    }
    if (draft.defaultModel.trim() && !models.includes(draft.defaultModel.trim())) {
      setMessage({ type: 'error', text: '默认模型必须存在于模型列表中。' })
      return
    }
    setBusy('save')
    setMessage({ type: 'info', text: '正在保存供应商并更新模型目录…' })
    try {
      const definitions = new Map(discoveredDefinitions.map(model => [model.id, model]))
      const payload = providerPayload({ ...draft, models: models.join('\n') })
      payload.models = models.map(model => definitions.get(model) || model)
      const saved = await bridge.saveProvider(payload)
      const next = mergeProviders(providers, saved)
      updateProviders(next)
      setSelectedProviderId(saved.id)
      setDraft(draftFromProvider(saved))
      setMessage({
        type: saved.integration?.ok === false ? 'error' : 'success',
        text: saved.integration?.ok === false
          ? '供应商已保存，但 OpenClaw 同步失败：' + (saved.integration.error || '未知错误')
          : '供应商已保存，' + saved.models.length + ' 个模型已回填到下方 Agent 下拉列表。',
      })
      setDiscoveredModels([])
      setDiscoveryMeta({})
    } catch (error) {
      setMessage({ type: 'error', text: '保存失败：' + errorMessage(error) })
    } finally {
      setBusy('')
    }
  }

  const isEditing = Boolean(selectedProviderId)
  const currentModels = new Set(parseLines(draft.models))

  return (
    <section className="provider-manager" aria-labelledby="provider-manager-title">
      <div className="provider-manager-head">
        <div>
          <div className="sec-title" id="provider-manager-title">供应商与模型目录</div>
          <p className="provider-manager-subtitle">在原 EDICT 模型页配置连接，自动发现模型或手动添加；保存后立即回填 Agent 模型选择。</p>
        </div>
        <div className="provider-manager-actions">
          <button className="btn btn-g provider-tool-btn" type="button" onClick={() => void loadProviders()} disabled={busy !== ''} title="刷新供应商">
            {busy === 'load' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            刷新
          </button>
          {desktopBridge()?.openSettings && (
            <button className="btn btn-g provider-tool-btn" type="button" onClick={() => void desktopBridge()?.openSettings?.()} title="打开完整设置">
              <ExternalLink size={14} />
              完整设置
            </button>
          )}
        </div>
      </div>

      {!bridgeAvailable ? (
        <div className="provider-offline" role="status">
          <Server size={18} />
          <div>
            <strong>仅在 Edict 桌面版可配置供应商</strong>
            <span>当前页面没有桌面安全存储桥接，无法安全接收 API Key。</span>
          </div>
        </div>
      ) : (
        <div className="provider-manager-body">
          <aside className="provider-catalog" aria-label="已保存供应商">
            <div className="provider-catalog-head">
              <span>已保存供应商</span>
              <button className="provider-icon-btn" type="button" onClick={resetDraft} title="新增供应商" aria-label="新增供应商">
                <Plus size={15} />
              </button>
            </div>
            {providers.length ? (
              <div className="provider-catalog-list">
                {providers.map((provider) => (
                  <button
                    className={'provider-catalog-item ' + (provider.id === selectedProviderId ? 'active' : '')}
                    key={provider.id}
                    type="button"
                    onClick={() => selectProvider(provider)}
                  >
                    <span className="provider-catalog-name">{provider.name || provider.id}</span>
                    <span className="provider-catalog-meta">
                      {provider.secretStored ? '密钥已设置' : '待设置密钥'} · {provider.models.length} 个模型
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="provider-catalog-empty">
                <Server size={18} />
                <span>还没有供应商</span>
                <small>点击右上角加号开始配置。</small>
              </div>
            )}
          </aside>

          <form className="provider-editor" onSubmit={(event) => void handleSave(event)}>
            <div className="provider-editor-title">
              <div>
                <strong>{isEditing ? '编辑 · ' + (draft.name || draft.id) : '新增供应商'}</strong>
                <span>{isEditing && draft.id ? '供应商 ID：' + draft.id : '支持 OpenAI 兼容接口'}</span>
              </div>
              {isEditing && (
                <button className="provider-icon-btn" type="button" onClick={resetDraft} title="关闭编辑" aria-label="关闭编辑">
                  <X size={15} />
                </button>
              )}
            </div>

            <div className="provider-form-grid">
              <label>
                <span>显示名称</span>
                <input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="例如：示例供应商 测试" autoComplete="organization" />
              </label>
              <label>
                <span>协议</span>
                <select value="openai-compatible" disabled>
                  <option value="openai-compatible">OpenAI 兼容</option>
                </select>
              </label>
            </div>

            <label>
              <span>Base URL</span>
              <input value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value })} placeholder="https://example.com/v1" inputMode="url" autoComplete="url" />
              <small>会自动尝试 <code>/v1/models</code>，找不到时再尝试 <code>/models</code>。</small>
            </label>

            <label>
              <span>API Key</span>
              <div className="provider-key-wrap">
                <KeyRound size={14} aria-hidden="true" />
                <input
                  type={showKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                  placeholder={isEditing ? '留空表示继续使用已保存密钥' : '粘贴供应商 API Key'}
                  autoComplete="new-password"
                />
                <button className="provider-key-toggle" type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? '隐藏 API Key' : '显示 API Key'} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <small>{isEditing && providers.find((provider) => provider.id === selectedProviderId)?.secretStored ? '密钥已安全保存；不会回显，也不会写入普通配置。' : '密钥只会在桌面主进程中处理并安全保存。'}</small>
            </label>

            <label>
              <span>模型 ID</span>
              <textarea value={draft.models} onChange={(event) => updateDraft({ models: event.target.value })} rows={4} placeholder="每行一个模型 ID，例如：model-id" spellCheck={false} />
              <small>可以直接编辑列表，也可以使用下方输入框添加单个模型。</small>
            </label>

            <div className="provider-manual-model">
              <input value={manualModel} onChange={(event) => setManualModel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addManualModel() } }} placeholder="手动添加模型 ID" aria-label="手动添加模型 ID" />
              <button className="btn btn-g" type="button" onClick={addManualModel} disabled={!manualModel.trim()}>
                <Plus size={14} />
                添加
              </button>
            </div>

            {discoveredModels.length > 0 && (
              <div className="provider-discovery">
                <div className="provider-discovery-head">
                  <div>
                    <strong>发现的模型</strong>
                    <span>{discoveryMeta.status !== undefined ? 'HTTP ' + discoveryMeta.status : ''}{discoveryMeta.latencyMs !== undefined ? (discoveryMeta.status !== undefined ? ' · ' : '') + discoveryMeta.latencyMs + ' ms' : ''}{discoveryMeta.endpoint ? ' · ' + discoveryMeta.endpoint : ''}</span>
                  </div>
                  <div className="provider-discovery-actions">
                    <button className="provider-text-btn" type="button" onClick={selectAllDiscovered}>全部加入</button>
                    <button className="provider-text-btn" type="button" onClick={clearDiscovered}>移除发现项</button>
                  </div>
                </div>
                <div className="provider-discovery-list">
                  {discoveredModels.map((model) => (
                    <label className="provider-model-check" key={model}>
                      <input type="checkbox" checked={currentModels.has(model)} onChange={(event) => setDiscoverySelection(model, event.target.checked)} />
                      <span>{model}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="provider-form-grid">
              <label>
                <span>默认模型（可选）</span>
                <input value={draft.defaultModel} onChange={(event) => updateDraft({ defaultModel: event.target.value })} placeholder="必须存在于上方模型列表" />
              </label>
              <div className="provider-security-note">
                <KeyRound size={14} />
                <span>API Key 不会进入模型列表、活动日志或 Git。</span>
              </div>
            </div>

            {message && (
              <div className={'provider-message ' + message.type} role={message.type === 'error' ? 'alert' : 'status'}>
                {message.type === 'error' ? <X size={14} /> : message.type === 'success' ? <Save size={14} /> : <Search size={14} />}
                <span>{message.text}</span>
              </div>
            )}

            {connectionTest.state !== 'idle' && (
              <div className={'provider-connection ' + connectionTest.state} role="status">
                <Timer size={14} aria-hidden="true" />
                <div>
                  <strong>{connectionTest.state === 'testing' ? '正在测试连接…' : connectionTest.state === 'success' ? '供应商连接正常' : '供应商连接失败'}</strong>
                  {connectionTest.state !== 'testing' && (
                    <span>
                      {connectionTest.status !== undefined ? 'HTTP ' + connectionTest.status : 'HTTP 未知'}
                      {connectionTest.latencyMs !== undefined ? ' · 延迟 ' + connectionTest.latencyMs + ' ms' : ''}
                      {connectionTest.modelCount !== undefined ? ' · 模型 ' + connectionTest.modelCount + ' 个' : ''}
                      {connectionTest.endpoint ? ' · ' + connectionTest.endpoint : ''}
                      {connectionTest.error ? ' · ' + connectionTest.error : ''}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="provider-form-actions">
              <button className="btn btn-g" type="button" onClick={() => void handleTest()} disabled={busy !== ''}>
                {busy === 'test' ? <LoaderCircle size={14} className="spin" /> : <Timer size={14} />}
                {busy === 'test' ? '测试中…' : '测试连接'}
              </button>
              <button className="btn btn-g" type="button" onClick={() => void handleDiscover()} disabled={busy !== ''}>
                {busy === 'discover' ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
                {busy === 'discover' ? '发现中…' : '发现模型'}
              </button>
              <button className="btn btn-p" type="submit" disabled={busy !== ''}>
                {busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
                {busy === 'save' ? '保存中…' : '保存并更新下拉'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}

