import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Archive, Check, Clock3, Crown, DoorOpen, LogOut, MessageSquare, Pause, Play, Radio, RefreshCw, Send, Settings, ShieldCheck, Trash2, UserPlus, Users, X } from 'lucide-react'
import { yushufangApi, type ChatAttachment, type YushufangOfficial, type YushufangResult, type YushufangRoom } from '../api'
import { useStore } from '../store'
import ChatComposer, { AttachmentList } from './ChatComposer'
import ThinkingControl, { sharedThinkingLevels, useModelCapabilities } from './ThinkingControl'

const ENDED = ['concluded', 'cancelled', 'archived']
const phaseLabel = (phase: string) => ({
  idle: '待命', running: '议事中', waiting: '等待继续', concluded: '议事结束',
  cancelled: '已解散', interrupted: '已暂停', archived: '已归档',
  failed: '回奏失败', partial_failed: '部分回奏失败',
}[phase] || phase)
const name = (official: YushufangOfficial) => official.name || official.label || official.id
const time = (value?: string) => value && !Number.isNaN(Date.parse(value))
  ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

export default function Yushufang() {
  const toast = useStore((state) => state.toast)
  const [officials, setOfficials] = useState<YushufangOfficial[]>([])
  const [rooms, setRooms] = useState<YushufangRoom[]>([])
  const [room, setRoom] = useState<YushufangRoom | null>(null)
  const [audience, setAudience] = useState<'prince' | 'ministers'>('ministers')
  const [selected, setSelected] = useState<string[]>([])
  const [topic, setTopic] = useState('')
  const [thinking, setThinking] = useState('default')
  const modelCapabilities = useModelCapabilities()
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [runtime, setRuntime] = useState<{ ok: boolean; errors: string[] } | null>(null)
  const [checkingRuntime, setCheckingRuntime] = useState(false)
  const revision = useRef(0)
  const operation = useRef(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const active = room && !ENDED.includes(room.phase)
  const activeRoom = rooms.find((item) => !ENDED.includes(item.phase))
  const prince = officials.find((item) => item.id === 'taizi')
  const isPrince = room ? room.audience === 'prince' : audience === 'prince'
  const participants = room?.participants || []
  const running = room?.phase === 'running' || room?.phase === 'waiting'
  const failed = room?.phase === 'failed' || room?.phase === 'partial_failed'
  const paused = failed || room?.phase === 'interrupted'
  const targetIds = room ? participants.map(item => item.id) : audience === 'prince' ? ['taizi'] : selected
  const targetCapabilities = targetIds.map(id => {
    const model = modelCapabilities.data?.agents.find(agent => agent.agentId === id)?.model || officials.find(agent => agent.id === id)?.model
    return modelCapabilities.data?.models.find(item => item.model === model)
  })
  const thinkingLevels = sharedThinkingLevels(targetCapabilities)
  const thinkingReady = !modelCapabilities.loading && !modelCapabilities.error && thinkingLevels.includes(thinking)
  const busyLabel = busy === 'resume'
    ? '正在恢复议事，等待会话状态同步…'
    : busy === 'cancel'
      ? '正在叫停本轮回奏…'
      : busy === 'open'
        ? '正在开启御书房…'
        : busy
          ? '正在处理御书房操作…'
          : ''

  const checkRuntime = useCallback(async () => {
    setCheckingRuntime(true)
    try { setRuntime(await yushufangApi.runtime()) }
    catch { setRuntime({ ok: false, errors: ['运行状态检测失败，请检查看板连接后重试。'] }) }
    finally { setCheckingRuntime(false) }
  }, [])
  useEffect(() => {
    void checkRuntime()
    const onFocus = () => void checkRuntime()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkRuntime])

  const load = useCallback(async () => {
    const version = revision.current
    setLoading(true)
    try {
      const [roster, history] = await Promise.all([yushufangApi.officials(), yushufangApi.rooms()])
      if (!roster.ok || !history.ok) throw new Error(roster.error || history.error || '读取御书房失败')
      setOfficials(roster.officials || roster.agents || [])
      const nextRooms = history.rooms || []
      setRooms(nextRooms)
      if (version === revision.current) {
        setRoom((current) => current
          ? nextRooms.find((item) => item.roomId === current.roomId) || null
          : nextRooms.find((item) => !ENDED.includes(item.phase)) || null)
        setError('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!room || ENDED.includes(room.phase)) return
    let stopped = false
    let pending = false
    const roomId = room.roomId
    const timer = setInterval(async () => {
      if (pending || operation.current) return
      const version = revision.current
      pending = true
      try {
        const result = await yushufangApi.rooms()
        if (!result.ok) throw new Error(result.error || '刷新失败')
        if (!stopped && version === revision.current) {
          setRooms(result.rooms || [])
          const next = result.rooms?.find((item) => item.roomId === roomId)
          if (next) setRoom(next)
        }
      } catch {
        if (!stopped) setError('会话状态刷新失败，请检查连接并刷新。')
      } finally { pending = false }
    }, 1200)
    return () => { stopped = true; clearInterval(timer) }
  }, [room?.roomId, room?.phase])

  useEffect(() => {
    const container = messagesRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [room?.roomId, room?.messages.length])

  const selectRoom = (next: YushufangRoom | null, mode: 'prince' | 'ministers' = 'ministers') => {
    revision.current += 1
    setRoom(next); setAudience(next?.audience || mode)
    setThinking(next?.thinkingDefault || 'default')
    setSelected([]); setTopic(''); setError(''); setNotice('')
  }

  const run = async (label: string, action: () => Promise<YushufangResult>, success?: string) => {
    if (operation.current) return null
    operation.current = true
    revision.current += 1
    setBusy(label); setError(''); setNotice('')
    try {
      const result = await action()
      if (!result.ok) throw new Error(result.error || '操作失败')
      if (result.room) {
        const next = result.room
        setRoom(next)
        setRooms((current) => [next, ...current.filter((item) => item.roomId !== next.roomId)])
      }
      if (success) setNotice(success)
      return result
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setError(text); toast(text, 'err')
      return null
    } finally {
      operation.current = false
      setBusy('')
    }
  }

  const openRoom = async () => {
    if (!thinkingReady) return
    if (activeRoom) {
      selectRoom(activeRoom)
      setNotice(`御书房当前已有未结束的议事：${activeRoom.topic}`)
      return
    }
    const ids = audience === 'prince' ? ['taizi'] : selected
    const result = await run('open', () => yushufangApi.open(topic.trim(), ids, thinking, audience))
    if (result?.ok) { setTopic(''); setSelected([]) }
  }
  const invite = async (ids: string[], joinPrince = false) => {
    if (!room) return
    if (joinPrince && !window.confirm('邀请太子列席当前臣子议事？太子将看到本场议事记录；此前的太子密谈不会带入。')) return
    const result = await run('invite', () => yushufangApi.invite(room.roomId, ids, joinPrince), '已召见，从下一轮开始回奏。')
    if (result?.ok) setSelected([])
  }
  const send = async (content: string, files: ChatAttachment[]) => {
    if (!room || !thinkingReady) return false
    const result = await run('speak', () => yushufangApi.speak(room.roomId, content, files.map((file) => file.id), thinking))
    if (result?.ok) {
      setNotice(result.queued ? '圣谕已排队，将在本轮回奏结束后传达。' : '圣谕已传达。')
    }
    return Boolean(result?.ok)
  }
  const askProgress = async (agentId: string) => {
    if (!room || !active) return
    const official = participants.find((item) => item.id === agentId)
    const result = await run(`progress:${agentId}`, () => yushufangApi.askProgress(room.roomId, agentId))
    if (result?.ok) {
      setNotice(result.duplicate
        ? `${name(official || { id: agentId, name: agentId })}已有一条进度询问在处理中。`
        : `已召见${name(official || { id: agentId, name: agentId })}，正在读取同一工作会话的最新进展。`)
    }
  }
  const beginRoom = (mode: 'prince' | 'ministers') => {
    if (activeRoom) {
      selectRoom(activeRoom)
      setNotice(`御书房当前已有未结束的议事：${activeRoom.topic}`)
      return
    }
    selectRoom(null, mode)
  }
  const newPrinceRoom = () => beginRoom('prince')
  const deleteRoom = async (target: YushufangRoom) => {
    if (!ENDED.includes(target.phase)) return
    if (!window.confirm(`确认永久删除这场御书房记录？\n\n${target.topic}\n\n会话消息、附件和临时运行文件都会删除，且无法恢复。`)) return
    const result = await run('delete', () => yushufangApi.delete(target.roomId))
    if (!result?.ok) return
    setRooms((current) => current.filter((item) => item.roomId !== target.roomId))
    if (room?.roomId === target.roomId) selectRoom(null)
  }
  const canOpen = !busy && !loading && !activeRoom && topic.trim() && (audience === 'prince' ? Boolean(prince) : selected.length > 0)

  return (
    <div className="yushu-page" aria-busy={Boolean(busy)}>
      <header className="yushu-header">
        <h2>御书房</h2>
        <div className="yushu-header-actions">
          <span className="yushu-policy"><ShieldCheck size={15} />议事调研 · 执行须御批</span>
          {busy && <span className="async-action-status" role="status" aria-live="polite">⟳ {busyLabel}</span>}
          <button className="btn btn-g" onClick={() => void load()} disabled={Boolean(busy) || loading} title="刷新御书房" aria-label="刷新御书房"><RefreshCw size={16} /></button>
          <button className="btn btn-g" onClick={() => beginRoom('ministers')} disabled={Boolean(busy)}><MessageSquare size={15} />新议事</button>
        </div>
      </header>
      {error && <div className="yushu-alert error" role="alert"><AlertTriangle size={16} />{error}</div>}
      {notice && !paused && <div className="yushu-alert success" role="status"><Check size={16} />{notice}</div>}
      <section className={`yushu-runtime ${runtime?.ok ? 'ready' : 'unavailable'}`} aria-label="运行依赖">
        <div role="status">{checkingRuntime || !runtime ? '正在检测运行依赖…' : runtime.ok
          ? 'OpenClaw / Node.js 已就绪'
          : runtime.errors.join(' ')}</div>
        <div className="yushu-header-actions">
          <button className="btn btn-g" onClick={() => void checkRuntime()} disabled={checkingRuntime} title="重新检测运行依赖" aria-label="重新检测运行依赖"><RefreshCw size={15} aria-hidden="true" /></button>
          {window.edictDesktop?.openSettings && <button className="btn btn-g" onClick={() => void window.edictDesktop?.openSettings?.('dependencies')}><Settings size={15} aria-hidden="true" />打开设置</button>}
        </div>
      </section>

      <div className="yushu-layout">
        <aside className="yushu-roster">
          <section className="yushu-prince">
            <div className="panel-title-row"><h3><Crown size={17} />召见太子</h3><span>直属皇上</span></div>
            <div className="yushu-prince-meta">{prince ? name(prince) : loading ? '正在读取太子名册…' : '未注册太子'}<small>{prince?.model || '尚未配置模型'}</small></div>
            <button className="btn btn-p" onClick={newPrinceRoom} disabled={!prince || Boolean(busy)}><DoorOpen size={15} />太子密谈</button>
            {active && !isPrince && !participants.some((item) => item.id === 'taizi') && <button className="btn btn-g" onClick={() => void invite(['taizi'], true)} disabled={!prince || Boolean(busy) || participants.length >= 4}><UserPlus size={15} />邀请太子列席</button>}
          </section>
          <section className="yushu-ministers">
            <div className="panel-title-row"><h3><Users size={17} />召见臣子</h3><span>最多四位</span></div>
            {loading && <p className="yushu-roster-state" role="status">正在读取臣子名册…</p>}
            {!loading && !officials.filter((item) => item.id !== 'taizi').length && <p className="yushu-roster-state">暂无可召见臣子，请检查 Agent 注册配置。</p>}
            {isPrince && <button className="btn btn-g" onClick={() => beginRoom('ministers')} disabled={Boolean(busy)}><MessageSquare size={15} />另开臣子议事</button>}
            <div className="yushu-roster-list">
              {officials.filter((item) => item.id !== 'taizi').map((official) => {
                const checked = selected.includes(official.id)
                const present = Boolean(active && participants.some((item) => item.id === official.id))
                const disabled = Boolean(busy) || isPrince || present || Boolean(room && !active) || (!checked && selected.length + (active ? participants.length : 0) >= 4)
                return <label key={official.id} className={`yushu-official ${checked ? 'selected' : ''} ${present ? 'in-room' : ''}`}>
                  <input type="checkbox" aria-label={name(official)} checked={checked || present} disabled={disabled} onChange={() => setSelected((current) => checked ? current.filter((id) => id !== official.id) : [...current, official.id])} />
                  <span className="yushu-official-copy"><strong>{name(official)}</strong><small>{official.role || official.id}</small><small title={official.model}>{official.model || '尚未配置模型'}</small></span>
                  {present ? <span className="yushu-room-mark">殿内</span> : checked && <span className="yushu-order">{selected.indexOf(official.id) + 1}</span>}
                </label>
              })}
            </div>
            {!isPrince && <div className="yushu-selection-note">已选 {selected.length} 位{active ? ` · 殿内 ${participants.length} 位` : ''}</div>}
            {active && !isPrince && <button className="btn btn-p" onClick={() => void invite(selected)} disabled={!selected.length || Boolean(busy)}><UserPlus size={15} />下诏入内</button>}
          </section>
        </aside>

        <section className="yushu-main">
          {!room ? <div className="yushu-empty">
            {isPrince ? <Crown size={30} /> : <Users size={30} />}
            <h3>{isPrince ? '太子密谈' : '殿内暂无臣子，可下诏召见'}</h3>
            <form className="yushu-open-form" onSubmit={(event) => { event.preventDefault(); if (canOpen) void openRoom() }}>
              <label><span>议题</span><textarea value={topic} onChange={(event) => setTopic(event.target.value)} rows={3} maxLength={500} placeholder="本次要商议什么？" disabled={Boolean(busy)} required /></label>
              <ThinkingControl levels={thinkingLevels} value={thinking} onChange={setThinking}
                loading={modelCapabilities.loading} error={modelCapabilities.error} onRetry={() => void modelCapabilities.reload()} disabled={Boolean(busy)} />
              {targetIds.length > 1 && <p className="thinking-note">仅列出本次获邀 Agent 共同可用的档位。</p>}
              <button className="btn btn-p yushu-open-button" type="submit" disabled={!canOpen || !thinkingReady}><DoorOpen size={15} />{busy === 'open' ? '下诏中…' : isPrince ? '召太子入内' : '下诏入内'}</button>
            </form>
          </div> : <div className="yushu-room">
            <div className="yushu-room-head">
              <div><div className="yushu-room-id">{isPrince ? '太子密谈' : '臣子议事'} · {room.roomId}</div><h3>{room.topic}</h3><span className={`yushu-phase ${room.phase}`}>{phaseLabel(room.phase)}</span></div>
              <div className="yushu-room-actions">
                {running && <button className="btn btn-g" onClick={() => void run('cancel', () => yushufangApi.cancel(room.roomId))} disabled={Boolean(busy)}><Pause size={14} />{busy === 'cancel' ? '叫停中…' : '叫停'}</button>}
                {paused && <button className="btn btn-g" onClick={() => void run('resume', () => yushufangApi.resume(room.roomId, thinking))} disabled={Boolean(busy) || !runtime?.ok || !thinkingReady}><Play size={14} />{busy === 'resume' ? '恢复中…' : failed ? '重试未完成回奏' : '继续议事'}</button>}
                {active && <button className="btn btn-g" onClick={() => void run('conclude', () => yushufangApi.conclude(room.roomId))} disabled={Boolean(busy) || running || Boolean(room.pendingMessages?.length)}><Check size={14} />结束议事</button>}
                {active && <button className="btn btn-danger" onClick={() => { if (window.confirm('解散当前议事，移出参会人并撤回排队圣谕？历史记录会保留。')) void run('disband', () => yushufangApi.disband(room.roomId)) }} disabled={Boolean(busy)}><LogOut size={14} />解散</button>}
              </div>
            </div>
            {failed && <div className="yushu-alert error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><span>{room.phase === 'partial_failed' ? '成功答复已保留。' : '本轮未能完成回奏。'} 排队圣谕已暂停，排查下方错误后可重试未完成回奏。</span></div>}
            <div className="yushu-participants"><span className="yushu-subtitle">殿内</span>{participants.map((official) => <span key={official.id} className={`yushu-participant ${room.currentAgentId === official.id ? 'speaking' : ''}`}>{official.id === 'taizi' && <Crown size={13} />}{name(official)}{room.currentAgentId === official.id && <span>回奏中</span>}{active && <button aria-label={`罢黜${name(official)}出殿`} title="罢黜出殿" onClick={() => void run('remove', () => yushufangApi.removeParticipant(room.roomId, official.id))} disabled={Boolean(busy)}><X size={14} /></button>}</span>)}</div>
            {Boolean(room.queue?.length) && <div className="yushu-turn-queue">回奏顺序：{room.queue?.map((id) => participants.find((item) => item.id === id)).filter((item): item is YushufangOfficial => Boolean(item)).map(name).join(' → ')}</div>}
            <section className="yushu-context" aria-label="Agent 实时工作状态">
              <div className="panel-title-row">
                <h3><Radio size={15} />实时工作状态</h3>
                <span>{room.sharedMemory ? '共享 Agent 主工作会话' : '旧房间隔离会话'}</span>
              </div>
              <p className="yushu-context-note">御书房只读取当前工作进度，不会改变原任务；状态每 1.2 秒刷新。</p>
              <div className="yushu-context-list">
                {participants.map((official) => {
                  const context = room.agentContexts?.[official.id]
                  const request = [...(room.progressRequests || [])].reverse().find((item) => item.agentId === official.id && ['queued', 'running'].includes(item.status))
                  const progressBusy = busy === `progress:${official.id}` || Boolean(request)
                  return <article className="yushu-context-entry" key={official.id}>
                    <div className="yushu-context-head">
                      <strong>{name(official)}</strong>
                      <span className={`yushu-context-status ${context?.busy ? 'working' : 'idle'}`}>
                        {context?.busy ? <Radio size={12} /> : <Clock3 size={12} />}{context?.busy ? '工作中' : '待命'}
                      </span>
                    </div>
                    <p>{context?.progress || '暂无可读取的工作进度。'}</p>
                    <div className="yushu-context-meta">
                      <span>{context?.sourceTaskId ? `原任务 ${context.sourceTaskId}` : 'Agent 主工作会话'}</span>
                      <span>{context?.lastActiveAt ? `最近更新 ${time(context.lastActiveAt)}` : '暂无活动时间'}</span>
                    </div>
                    {active && <button className="btn btn-g" type="button" onClick={() => void askProgress(official.id)} disabled={Boolean(busy) || !runtime?.ok || progressBusy}>
                      <Radio size={13} />{request ? (request.status === 'running' ? '询问中…' : '已排队') : '询问进度'}
                    </button>}
                  </article>
                })}
              </div>
            </section>
            {room.capabilities && <details className="yushu-capabilities"><summary>本场实际配置</summary>{Object.entries(room.capabilities).map(([id, config]) => <div key={id}><strong>{officials.find((item) => item.id === id)?.name || id}</strong><span>模型：{config.resolvedModel || config.model}{config.resolvedModel ? ' · 已回执' : ' · 待模型回执'}</span><span>Skills：{config.skills.join('、') || '无'}</span><span>网页搜索：{config.webSearch ? '开放' : '关闭'} · 网页读取：{config.webFetch ? '开放' : '关闭'}</span><span>MCP 资源读取：{config.mcpServers.join('、') || '无已配置服务'}</span><span>命令、文件写入、任务派发：议事中禁用</span></div>)}</details>}

            {room.capabilities && <div className="yushu-turn-queue" role="status" aria-label="实际思考深度">{Object.entries(room.capabilities).filter(([, config]) => config.effectiveThinking).map(([id, config]) => <span key={id}>{officials.find((item) => item.id === id)?.name || id} · 思考 {config.requestedThinking}{config.requestedThinking !== config.effectiveThinking ? `（实际参数 ${config.effectiveThinking}）` : ''} </span>)}</div>}
            <div className="yushu-messages" ref={messagesRef} role="log" aria-label="议事记录">
              {room.messages.map((item, index) => <div key={item.id || `${item.type}-${item.createdAt || index}`} className={`yushu-message ${item.type}`}><div className="yushu-message-meta"><strong>{item.type === 'emperor' ? '皇上' : item.type === 'system' ? '司礼监' : item.type === 'error' ? '运行错误' : item.type === 'progress' ? '进度回奏' : item.officialName || item.officialId || '臣子'}</strong><time>{time(item.createdAt)}</time></div><div className="yushu-message-body">{item.content}</div><AttachmentList scope={room.roomId} files={item.attachments} /></div>)}
              {running && <div className="yushu-typing" role="status">{room.currentAgentId ? `${participants.find((item) => item.id === room.currentAgentId)?.name || room.currentAgentId} 正在回奏…` : '正在准备本轮回奏…'}</div>}
            </div>
            {Boolean(room.toolActivity?.length) && <details className="yushu-capabilities"><summary>工具活动 · {room.toolActivity?.length}</summary>{room.toolActivity?.map((item, index) => <div key={index}><span>{time(item.at)} · {officials.find((official) => official.id === item.agentId)?.name || item.agentId} · {item.tool} · {item.state === 'error' ? '失败或已拦截' : item.state === 'completed' ? '已完成' : '调用中'}</span></div>)}</details>}

            {Boolean(room.pendingMessages?.length) && <section className="yushu-pending" aria-label="排队圣谕"><h4>排队圣谕 · {room.pendingMessages?.length}</h4>{room.pendingMessages?.map((item, index) => <div key={item.id}><div><span>{index + 1}. {item.content}</span><AttachmentList scope={room.roomId} files={item.attachments} /></div><button className="btn btn-g" title="撤回排队圣谕" aria-label={`撤回第${index + 1}条圣谕`} onClick={() => void run('dequeue', () => yushufangApi.removeQueued(room.roomId, item.id))} disabled={Boolean(busy)}><X size={14} /></button></div>)}</section>}
            {active && <ThinkingControl levels={thinkingLevels} value={thinking} onChange={setThinking}
              loading={modelCapabilities.loading} error={modelCapabilities.error} onRetry={modelCapabilities.reload} disabled={Boolean(busy)} />}
            {active && <ChatComposer key={room.roomId} scope={room.roomId} label="皇上发言" busy={Boolean(busy)} paused={Boolean(paused || !runtime?.ok || !thinkingReady)} placeholder={paused ? '议事已暂停，草稿会保留…' : '传达圣谕…'} sendLabel={running ? '排队传旨' : '传旨'} onSend={send} />}

            {Boolean(room.proposedActions?.length) && <section className="yushu-approvals"><div className="panel-title-row"><h3>待御批事项</h3><span>{room.phase === 'concluded' ? '议事已结束，可御批' : '结束议事后御批'}</span></div>{room.proposedActions?.map((action) => <div className={`yushu-approval ${action.status}`} key={action.id}>
              <div><strong>{action.title}</strong>{action.detail && <p>{action.detail}</p>}{action.taskId && <p>旨意：{action.taskId} · 已交太子分拣</p>}</div>
              <div className="yushu-approval-actions">
                {action.status === 'approved' ? <>
                  <span className="approved">{action.taskId ? '已下旨' : '已准奏'}</span>
                  {!action.taskId && <button className="btn btn-p" disabled={Boolean(busy) || room.phase !== 'concluded'} onClick={() => {
                    if (window.confirm(`确认将以下事项下旨至三省六部？\n\n${action.title}\n${action.detail || ''}\n\n将创建真实任务，进入太子分拣、三省审核及六部执行；不会转交其他密谈记录。`)) void run('execute', () => yushufangApi.execute(room.roomId, action.id))
                  }}><Send size={14} />下旨执行</button>}
                </> : action.status === 'rejected' ? <span className="rejected">已驳回</span> : <>
                  <button className="btn btn-g" onClick={() => void run('approve', () => yushufangApi.approve(room.roomId, action.id, true))} disabled={Boolean(busy) || room.phase !== 'concluded'}><Check size={14} />准奏</button>
                  <button className="btn btn-danger" onClick={() => void run('approve', () => yushufangApi.approve(room.roomId, action.id, false))} disabled={Boolean(busy) || room.phase !== 'concluded'}><X size={14} />驳回</button>
                </>}
              </div>
            </div>)}</section>}
            {ENDED.includes(room.phase) && <div className="yushu-archive-row"><span>{room.phase === 'archived' ? '已归入内廷密档' : '议事记录已保存'}</span>{room.phase !== 'archived' && <button className="btn btn-g" onClick={() => void run('archive', () => yushufangApi.archive(room.roomId))} disabled={Boolean(busy)}><Archive size={14} />归档</button>}<button className="btn btn-g" onClick={() => beginRoom('ministers')} disabled={Boolean(busy)}><MessageSquare size={14} />新议事</button></div>}
          </div>}
        </section>
      </div>
      {rooms.length > 0 && <section className="yushu-history"><div className="panel-title-row"><h3><Archive size={16} />内廷密档</h3><span>{rooms.length} 场</span></div><div className="yushu-history-list">{rooms.map((item) => <div className="yushu-history-entry" key={item.roomId}><button className={item.roomId === room?.roomId ? 'active' : ''} onClick={() => selectRoom(item)} disabled={Boolean(busy)}><span>{item.topic}</span><small>{item.audience === 'prince' ? '太子密谈' : '臣子议事'} · {phaseLabel(item.phase)}</small></button>{ENDED.includes(item.phase) && <button className="yushu-history-delete" onClick={(event) => { event.stopPropagation(); void deleteRoom(item) }} disabled={Boolean(busy)} aria-label={`删除${item.topic}`} title="永久删除记录"><Trash2 size={14} />删除</button>}</div>)}</div></section>}
    </div>
  )
}
