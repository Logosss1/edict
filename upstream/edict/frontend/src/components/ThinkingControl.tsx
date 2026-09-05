import { useCallback, useEffect, useId, useState } from 'react'
import { LoaderCircle, RefreshCw, Save, ScanLine } from 'lucide-react'

export interface ModelCapability {
  model: string
  providerId: string
  modelId: string
  levels: string[]
  declaredLevels?: string[]
  probeLevels?: string[]
  runtimeLevels: string[]
  mapping: Record<string, string>
  wireMapping?: Record<string, string>
  source: string
  warnings: string[]
  evidence?: Record<string, { status: string; latencyMs?: number; checkedAt?: string }>
}
interface CapabilityData {
  ok: boolean
  error?: string
  models: ModelCapability[]
  agents: Array<{ agentId: string; model: string; thinkingDefault?: string }>
}

async function request(path = '', body?: unknown): Promise<CapabilityData> {
  const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/model-capabilities${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  })
  const result = await response.json()
  if (!response.ok || result.ok === false) throw new Error(result.error || '模型能力读取失败')
  return result
}

export function useModelCapabilities() {
  const [data, setData] = useState<CapabilityData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    setLoading(true)
    try { setData(await request()); setError('') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setData(null) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    void reload()
    const refresh = () => { void reload() }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [reload])
  return { data, error, loading, reload }
}

export const thinkingLabel = (level: string) => level === 'default' ? '模型默认' : level === 'none' ? 'none（关闭）' : level
export const capabilitySource = (source: string) => ({
  catalog: '已知模型定义', official: '已知模型定义', provider: '模型配置声明',
  configured: '运行配置声明', config: '运行配置声明', manual: '手动声明',
  unknown: '能力未确认', probe: '请求已接受', detected: '请求已接受',
}[source] || source)

export function sharedThinkingLevels(capabilities: Array<ModelCapability | undefined>): string[] {
  if (!capabilities.length || capabilities.some(item => !item)) return []
  return capabilities[0]!.levels.filter(level => capabilities.every(item => item!.levels.includes(level)))
}

export default function ThinkingControl({ levels, value, onChange, disabled, loading, error, onRetry }: {
  levels: string[]; value: string; onChange: (value: string) => void
  disabled?: boolean; loading?: boolean; error?: string; onRetry?: () => void
}) {
  const id = useId()
  const invalid = !loading && levels.length > 0 && !levels.includes(value)
  return <fieldset className="thinking-control" disabled={disabled || loading}>
    <legend>思考深度</legend>
    {loading ? <span className="thinking-note" role="status">正在读取模型档位…</span> :
      <div className="thinking-options" role="radiogroup" aria-label="思考深度">
        {levels.map(level => <label key={level} className={value === level ? 'selected' : ''}>
          <input type="radio" name={id} value={level} checked={value === level} onChange={() => onChange(level)} />
          <span>{thinkingLabel(level)}</span>
        </label>)}
      </div>}
    {invalid && <p className="thinking-error" role="alert">原档位 {thinkingLabel(value)} 不适用于当前模型，请重新选择；未自动降档。</p>}
    {error && <p className="thinking-error" role="alert">{error}</p>}
    {!loading && !error && !levels.length && <p className="thinking-note">请先选择已配置模型的 Agent。</p>}
    {error && onRetry && <button className="btn btn-g" type="button" onClick={onRetry}><RefreshCw size={14} />重新读取</button>}
  </fieldset>
}

export function CapabilityTools({ capability, onChanged }: { capability: ModelCapability; onChanged: () => Promise<void> }) {
  const [manual, setManual] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const candidates = capability.probeLevels ?? [...new Set([
    ...capability.levels.filter(level => level !== 'default'), ...Object.keys(capability.evidence || {}),
  ])].slice(0, 8)
  const [probeLevels, setProbeLevels] = useState<string[]>([])
  const act = async (kind: string, action: () => Promise<unknown>) => {
    setBusy(kind); setMessage(''); setError('')
    try {
      await action()
      await onChanged()
      setMessage(kind === 'probe' ? '检测结束。请求被接受不代表参数一定生效，请查看逐档结果。' : '能力设置已更新；当前会话不会被重启。')
      setConfirmed(false)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }
  return <div className="thinking-capability">
    <div className="thinking-note" role="status">来源：{capabilitySource(capability.source)} · {capability.model}</div>
    {capability.warnings?.map(warning => <p className="thinking-note" key={warning}>{warning}</p>)}
    {capability.declaredLevels?.some(level => !capability.levels.includes(level)) &&
      <p className="thinking-note">已声明但当前不可设置：{capability.declaredLevels.filter(level => !capability.levels.includes(level)).join('、')}。接口接受检测请求，不会自动解除原生运行限制。</p>}
    {Object.entries(capability.mapping || {}).filter(([level, actual]) => level !== actual).length > 0 &&
      <p className="thinking-note">参数映射（选择 → 运行时 → 供应商）：{Object.entries(capability.mapping).filter(([level, actual]) => level !== actual).map(([level, actual]) => `${level} → ${actual} → ${capability.wireMapping?.[level] ?? level}`).join('；')}</p>}
    <details>
      <summary>检测与高级配置</summary>
      <div className="thinking-advanced">
        <fieldset disabled={Boolean(busy)}>
          <legend>检测档位</legend>
          <div className="thinking-probes">{candidates.map(level => <label key={level}>
            <input type="checkbox" checked={probeLevels.includes(level)} onChange={event => setProbeLevels(current => event.target.checked ? [...current, level] : current.filter(item => item !== level))} />
            {level}
          </label>)}</div>
          {!candidates.length && <p className="thinking-note">暂无已声明档位。请先填写下方手动声明。</p>}
        </fieldset>
        <label className="thinking-consent"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={Boolean(busy)} />
          我确认向此供应商发送 {probeLevels.length} 次短请求，可能产生费用。
        </label>
        <button type="button" className="btn btn-g" disabled={Boolean(busy) || !confirmed || !probeLevels.length} onClick={() => void act('probe', async () => {
          const payload = { model: capability.model, levels: probeLevels, confirmed: true }
          const bridge = (window as Window & { edictDesktop?: { probeModelThinking?: (payload: unknown) => Promise<{ ok?: boolean; error?: string }> } }).edictDesktop
          const result = bridge?.probeModelThinking ? await bridge.probeModelThinking(payload) : await request('/probe', payload)
          if (result.ok === false) throw new Error(result.error || '检测失败')
        })}>{busy === 'probe' ? <LoaderCircle size={14} className="spin" /> : <ScanLine size={14} />}{busy === 'probe' ? '检测中…' : '检测选中档位'}</button>
        {capability.evidence && <ul className="thinking-evidence">{Object.entries(capability.evidence).map(([level, evidence]) =>
          <li key={level}><b>{level}</b><span>{({
            accepted: '请求被接受，效果未证实', rejected: '明确不支持', unsupported: '明确不支持',
            error: '检测失败，能力未知', unknown: '结果未知', timeout: '超时', ignored: '参数被忽略',
          }[evidence.status] || evidence.status)}{evidence.latencyMs !== undefined ? ` · ${evidence.latencyMs} ms` : ''}</span>
            {evidence.checkedAt && <time>{new Date(evidence.checkedAt).toLocaleString()}</time>}</li>)}</ul>}
        <label>手动声明档位<input name="reasoning-efforts" autoComplete="off" value={manual} onChange={event => setManual(event.target.value)} placeholder="low, medium, high" disabled={Boolean(busy)} spellCheck={false} /></label>
        <p className="thinking-note">手动声明不是验证结果。ultra 与 adaptive 暂无受支持的原生参数映射，不能作为思考档位启用。</p>
        <div className="thinking-actions">
          <button type="button" className="btn btn-g" disabled={Boolean(busy) || !manual.trim()} onClick={() => void act('save', () => request('/configure', { model: capability.model, levels: manual.split(/[\s,，]+/).filter(Boolean) }))}><Save size={14} />保存声明</button>
          <button type="button" className="btn btn-g" disabled={Boolean(busy)} onClick={() => void act('reset', () => request('/configure', { model: capability.model, levels: null }))}><RefreshCw size={14} />恢复自动识别</button>
        </div>
        {message && <p className="thinking-note" role="status">{message}</p>}
        {error && <p className="thinking-error" role="alert">{error}</p>}
      </div>
    </details>
  </div>
}
