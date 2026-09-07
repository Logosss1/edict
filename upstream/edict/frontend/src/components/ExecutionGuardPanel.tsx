import { AlertTriangle, CheckCircle2, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, type ReadinessCheck, type ReadinessData } from '../api'
import type { TabKey } from '../store'
import { useStore } from '../store'

interface ExecutionGuardPanelProps {
  initialReadiness?: ReadinessData | null
  onSelectTab: (tab: TabKey) => void
}

const routeLabels: Record<string, string> = {
  board: '旨意看板',
  yushufang: '御书房',
  court: '朝堂议政',
  externalDispatch: '外部派发',
}

function targetSettingsTab(target?: string): string {
  if (target === 'models') return 'agents'
  return target || 'providers'
}

function checkStatus(check: ReadinessCheck): { label: string; className: string } {
  if (check.ready) return { label: '已就绪', className: 'ready' }
  return check.blocking === false || check.severity === 'warning'
    ? { label: '提醒', className: 'warning' }
    : { label: '会阻塞执行', className: 'blocker' }
}

export default function ExecutionGuardPanel({ initialReadiness, onSelectTab }: ExecutionGuardPanelProps) {
  const toast = useStore((state) => state.toast)
  const [readiness, setReadiness] = useState<ReadinessData | null>(initialReadiness || null)
  const [loading, setLoading] = useState(!initialReadiness)
  const [repairing, setRepairing] = useState(false)
  const [error, setError] = useState('')

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      setReadiness(await api.readiness())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '执行保障检测失败，请检查看板连接。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (initialReadiness) setReadiness(initialReadiness)
  }, [initialReadiness])

  useEffect(() => {
    if (!initialReadiness) void refresh()
  }, [])

  const failedChecks = useMemo(() => (readiness?.checks || []).filter((check) => !check.ready), [readiness])
  const blockerCount = readiness?.summary?.blockers ?? failedChecks.filter((check) => check.blocking !== false && check.severity !== 'warning').length
  const warningCount = readiness?.summary?.warnings ?? failedChecks.filter((check) => check.blocking === false || check.severity === 'warning').length

  const openCheckAction = async (check: ReadinessCheck) => {
    const action = check.action
    if (!action || action.type === 'none') return
    if (action.type === 'workspace-permission') {
      await window.edictDesktop?.openWorkspacePermissions?.()
      return
    }
    if (action.target === 'models') {
      onSelectTab('models')
      return
    }
    await window.edictDesktop?.openSettings?.(targetSettingsTab(action.target))
  }

  const repair = async () => {
    if (repairing) return
    setRepairing(true)
    setError('')
    try {
      const result = await api.preflightRepair('sync_runtime')
      if (!result.ok) throw new Error(result.error || '应用内配置同步失败')
      setReadiness(result.readiness || null)
      toast(result.message || '应用内运行配置已同步', 'ok')
      if (!result.readiness) await refresh()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      toast(message, 'err')
    } finally {
      setRepairing(false)
    }
  }

  const routes = Object.entries(readiness?.routes || {})

  return (
    <section className="execution-guard" aria-labelledby="execution-guard-title">
      <div className="execution-guard-head">
        <div>
          <div className="execution-guard-kicker"><ShieldCheck size={15} />开工前统一检查</div>
          <h2 id="execution-guard-title">执行保障</h2>
          <p>统一检查工作区、运行依赖、供应商、模型、Agent 绑定与派发渠道。这里的结果同时适用于旨意看板、御书房和朝堂议政。</p>
        </div>
        <div className="execution-guard-actions">
          <button className="btn btn-g" type="button" onClick={() => void refresh()} disabled={loading || repairing}>
            {loading ? <LoaderCircle className="guard-spin" size={15} /> : <RefreshCw size={15} />}重新检测
          </button>
          <button className="btn btn-p" type="button" onClick={() => void repair()} disabled={repairing || loading}>
            {repairing ? <LoaderCircle className="guard-spin" size={15} /> : <Wrench size={15} />}一键同步应用配置
          </button>
        </div>
      </div>

      {error && <div className="execution-guard-error" role="alert"><AlertTriangle size={16} />{error}</div>}
      {loading && !readiness && <div className="execution-guard-loading" role="status"><LoaderCircle className="guard-spin" size={20} />正在检查执行环境…</div>}

      {readiness && <>
        <div className={`execution-guard-summary ${readiness.ready ? 'ready' : 'blocked'}`} role="status">
          <div className="execution-guard-summary-icon">{readiness.ready ? <CheckCircle2 size={24} /> : <AlertTriangle size={24} />}</div>
          <div>
            <strong>{readiness.ready ? '可以开始工作' : '暂不能保证任务连续执行'}</strong>
            <span>{readiness.next || '请按下方检查项处理问题后重新检测。'}</span>
          </div>
          <div className="execution-guard-counts"><b>{blockerCount}</b><span>阻塞项</span><b>{warningCount}</b><span>提醒项</span></div>
        </div>

        <section className="execution-guard-routes" aria-label="可用工作入口">
          <div className="guard-section-title">工作入口</div>
          <div className="guard-route-grid">
            {routes.map(([id, route]) => <article key={id} className={`guard-route ${route.ready ? 'ready' : 'blocked'}`}>
              <div><strong>{routeLabels[id] || id}</strong><span>{route.mode === 'local' ? '桌面本地' : route.mode === 'external' ? '外部渠道' : '已关闭'}</span></div>
              <p>{route.detail}</p>
              <span className="guard-route-status">{route.ready ? '● 可用' : '● 需处理'}</span>
            </article>)}
          </div>
        </section>

        <section className="execution-guard-checks" aria-label="执行保障检查项">
          <div className="guard-section-title">逐项检查</div>
          <div className="guard-check-list">
            {(readiness.checks || []).map((check) => {
              const status = checkStatus(check)
              return <article className={`guard-check ${status.className}`} key={check.id}>
                <div className="guard-check-icon">{check.ready ? <CheckCircle2 size={18} /> : status.className === 'warning' ? <AlertTriangle size={18} /> : <AlertTriangle size={18} />}</div>
                <div className="guard-check-copy"><div><strong>{check.label}</strong><span className={`guard-status ${status.className}`}>{status.label}</span></div><p>{check.detail}</p></div>
                {!check.ready && check.action?.type !== 'none' && <button className="btn btn-g guard-check-action" type="button" onClick={() => void openCheckAction(check)}>
                  <ExternalLink size={14} />{check.action?.label || '去处理'}
                </button>}
              </article>
            })}
          </div>
        </section>
      </>}
    </section>
  )
}
