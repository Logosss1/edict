import { useEffect, useState, useRef, useCallback } from 'react';
import { useStore, getPipeStatus, deptColor, stateLabel, STATE_LABEL } from '../store';
import { api } from '../api';
import { waitForTaskOperation } from '../async-actions';
import { formatDashboardDateTime, formatDashboardTime } from '../time';
import type {
  Task,
  TaskActivityData,
  SchedulerStateData,
  ActivityEntry,
  TodoItem,
  PhaseDuration,
} from '../api';
import ConfirmDialog from './ConfirmDialog';

const AGENT_LABELS: Record<string, string> = {
  main: '太子',
  zhongshu: '中书省',
  menxia: '门下省',
  shangshu: '尚书省',
  libu: '礼部',
  hubu: '户部',
  bingbu: '兵部',
  xingbu: '刑部',
  gongbu: '工部',
  libu_hr: '吏部',
  zaochao: '钦天监',
};

const NEXT_LABELS: Record<string, string> = {
  Taizi: '中书省起草',
  Zhongshu: '门下省审议',
  Menxia: '尚书省派发',
  Assigned: '开始执行',
  Doing: '进入审查',
  Review: '完成',
};

function fmtStalled(sec: number): string {
  const v = Math.max(0, sec);
  if (v < 60) return `${v}秒`;
  if (v < 3600) return `${Math.floor(v / 60)}分${v % 60}秒`;
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  return `${h}小时${m}分`;
}

function fmtActivityTime(ts: number | string | undefined): string {
  return formatDashboardTime(ts, { showSeconds: true });
}

type ActionDialog = {
  title: string;
  message: string;
  okLabel: string;
  okClass?: string;
  onOk: (reason: string) => void;
};

export default function TaskModal() {
  const modalTaskId = useStore((s) => s.modalTaskId);
  const setModalTaskId = useStore((s) => s.setModalTaskId);
  const liveStatus = useStore((s) => s.liveStatus);
  const loadAll = useStore((s) => s.loadAll);
  const toast = useStore((s) => s.toast);

  const [activityData, setActivityData] = useState<TaskActivityData | null>(null);
  const [schedData, setSchedData] = useState<SchedulerStateData | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionLabel, setActionLabel] = useState('');
  const [actionDialog, setActionDialog] = useState<ActionDialog | null>(null);
  const laTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const task = liveStatus?.tasks?.find((t) => t.id === modalTaskId) || null;

  const fetchActivity = useCallback(async () => {
    if (!modalTaskId) return;
    try {
      const d = await api.taskActivity(modalTaskId);
      setActivityData(d);
    } catch {
      setActivityData(null);
    }
  }, [modalTaskId]);

  const fetchSched = useCallback(async () => {
    if (!modalTaskId) return;
    try {
      const d = await api.schedulerState(modalTaskId);
      setSchedData(d);
    } catch {
      setSchedData(null);
    }
  }, [modalTaskId]);

  useEffect(() => {
    if (!modalTaskId || !task) return;
    fetchActivity();
    fetchSched();

    const isDone = ['Done', 'Cancelled'].includes(task.state);
    if (!isDone) {
      laTimerRef.current = setInterval(() => {
        fetchActivity();
        fetchSched();
      }, 4000);
    }

    return () => {
      if (laTimerRef.current) {
        clearInterval(laTimerRef.current);
        laTimerRef.current = null;
      }
    };
  }, [modalTaskId, task?.state, fetchActivity, fetchSched]);

  // scroll log on new entries
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [activityData?.activity?.length]);

  if (!modalTaskId || !task) return null;

  const close = () => setModalTaskId(null);

  const stages = getPipeStatus(task);
  const activeStage = stages.find((s) => s.status === 'active');
  const hb = task.heartbeat || { status: 'unknown' as const, label: '⚪ 无数据' };
  // Scheduler bookkeeping is not a real Sansheng-Liubu handoff. Keep it out
  // of the workflow timeline so entries such as “太子调度 → 太子” cannot be
  // mistaken for the task returning to Taizi.
  const flowLog = (task.flow_log || []).filter((entry) => entry.kind !== 'scheduler' && entry.from !== '太子调度');
  const todos = task.todos || [];
  const todoDone = todos.filter((x) => x.status === 'completed').length;
  const todoTotal = todos.length;
  const canStop = !['Done', 'Blocked', 'Cancelled'].includes(task.state);
  const canCancel = !['Done', 'Cancelled'].includes(task.state);
  const canResume = ['Blocked', 'Cancelled'].includes(task.state);
  const canDelete = ['Done', 'Cancelled'].includes(task.state);

  const doTaskAction = async (action: string, reason: string) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionLabel(action === 'resume' ? '正在恢复，并等待调度器确认…' : action === 'stop' ? '正在叫停，并等待进程退出…' : '正在取消，并等待状态落盘…');
    try {
      const r = await api.taskAction(task.id, action, reason);
      if (r.ok) {
        const waited = await waitForTaskOperation(task.id, action as 'stop' | 'cancel' | 'resume', r.state);
        await loadAll();
        if (waited.status === 'confirmed') {
          toast(r.message || '操作已确认', 'ok');
          close();
        } else if (waited.status === 'failed') {
          toast(waited.detail || '调度器未能完成操作', 'err');
          await fetchSched();
        } else {
          toast('操作已提交，后台仍在处理；当前窗口会继续保留。');
          await fetchSched();
        }
      } else {
        toast(r.error || '操作失败', 'err');
      }
    } catch {
      toast('服务器连接失败', 'err');
    } finally {
      setActionLabel('');
      setActionBusy(false);
    }
  };

  const deleteTask = async () => {
    setActionBusy(true);
    setActionLabel('正在删除记录…');
    try {
      const r = await api.deleteTask(task.id);
      if (r.ok) {
        toast(r.message || '任务记录已删除', 'ok');
        close();
        loadAll();
      } else {
        toast(r.error || '删除失败', 'err');
      }
    } catch {
      toast('服务器连接失败', 'err');
    } finally {
      setActionLabel('');
      setActionBusy(false);
    }
  };

  const handleDelete = () => {
    if (actionBusy || !canDelete) return;
    setActionDialog({
      title: '永久删除任务记录',
      message: '确认删除 ' + task.id + '？' + (task.title ? '\n\n' + task.title : '') + '\n\n任务记录会从所有任务页面移除，且无法恢复。',
      okLabel: '永久删除',
      okClass: 'btn-cancel',
      onOk: () => { setActionDialog(null); void deleteTask(); },
    });
  };

  const submitReview = async (action: string, comment: string) => {
    setActionBusy(true);
    setActionLabel(action === 'approve' ? '正在提交准奏…' : '正在提交封驳…');
    try {
      const labels: Record<string, string> = { approve: '准奏', reject: '封驳' };
      const r = await api.reviewAction(task.id, action, comment);
      if (r.ok) {
        toast(`✅ ${task.id} 已${labels[action]}`, 'ok');
        loadAll();
        close();
      } else {
        toast(r.error || '操作失败', 'err');
      }
    } catch {
      toast('服务器连接失败', 'err');
    } finally {
      setActionLabel('');
      setActionBusy(false);
    }
  };

  const doReview = (action: string) => {
    if (actionBusy) return;
    const labels: Record<string, string> = { approve: '准奏', reject: '封驳' };
    setActionDialog({
      title: labels[action] + ' ' + task.id,
      message: '请确认审议决定；批注可留空，提交后会立即刷新任务状态。',
      okLabel: '确认' + labels[action],
      okClass: action === 'approve' ? 'btn-resume' : 'btn-cancel',
      onOk: (comment) => { setActionDialog(null); void submitReview(action, comment); },
    });
  };

  const submitAdvance = async (comment: string) => {
    setActionBusy(true);
    setActionLabel('正在推进，并等待下一阶段派发…');
    try {
      const r = await api.advanceState(task.id, comment);
      if (r.ok) {
        toast(`⏩ ${r.message}`, 'ok');
        loadAll();
        close();
      } else {
        toast(r.error || '推进失败', 'err');
      }
    } catch {
      toast('服务器连接失败', 'err');
    } finally {
      setActionLabel('');
      setActionBusy(false);
    }
  };

  const doAdvance = () => {
    if (actionBusy) return;
    const next = NEXT_LABELS[task.state] || '下一步';
    setActionDialog({
      title: '手动推进 ' + task.id,
      message: '当前阶段：' + task.state + '\n下一阶段：' + next + '\n\n说明可留空；推进后会按原流程派发下一阶段。',
      okLabel: '确认推进',
      okClass: 'btn-resume',
      onOk: (comment) => { setActionDialog(null); void submitAdvance(comment); },
    });
  };

  const submitSchedAction = async (action: string, reason: string) => {
    const labels: Record<string, string> = { retry: '重试', escalate: '升级', rollback: '回滚' };
    const handlers: Record<string, (id: string, r: string) => Promise<{ ok: boolean; message?: string; error?: string }>> = {
      retry: api.schedulerRetry,
      escalate: api.schedulerEscalate,
      rollback: api.schedulerRollback,
    };
    setActionBusy(true);
    setActionLabel(`正在${labels[action]}，等待调度器确认…`);
    try {
      const r = await handlers[action](task.id, reason);
      if (!r.ok) {
        toast(r.error || (labels[action] + '失败'), 'err');
        return;
      }
      const waited = await waitForTaskOperation(task.id, 'dispatch');
      await fetchSched();
      await loadAll();
      if (waited.status === 'confirmed') toast(r.message || '操作成功', 'ok');
      else if (waited.status === 'failed') toast(waited.detail || (labels[action] + '失败'), 'err');
      else toast(`${labels[action]}已提交，后台仍在处理。`);
    } catch {
      toast('服务器连接失败', 'err');
    } finally {
      setActionLabel('');
      setActionBusy(false);
    }
  };

  const doSchedAction = async (action: string) => {
    if (actionBusy) return;
    if (action === 'scan') {
      setActionBusy(true);
      setActionLabel('正在扫描停滞任务…');
      try {
        const r = await api.schedulerScan(180);
        if (r.ok) toast(`🔍 扫描完成：${r.count || 0} 个动作`, 'ok');
        else toast(r.error || '扫描失败', 'err');
        fetchSched();
      } catch {
        toast('服务器连接失败', 'err');
      } finally {
        setActionLabel('');
        setActionBusy(false);
      }
      return;
    }
    const labels: Record<string, string> = { retry: '重试', escalate: '升级', rollback: '回滚' };
    setActionDialog({
      title: '太子调度 · ' + labels[action],
      message: '将对 ' + task.id + ' 执行“' + labels[action] + '”。原因可留空，提交后会刷新调度状态。',
      okLabel: '确认' + labels[action],
      okClass: action === 'rollback' ? 'btn-cancel' : 'btn-resume',
      onOk: (reason) => { setActionDialog(null); void submitSchedAction(action, reason); },
    });
  };

  const handleStop = () => {
    if (actionBusy) return;
    setActionDialog({
      title: '叫停任务',
      message: '确认叫停 ' + task.id + '？\n\n当前执行会被停止，任务保留为阻塞状态，之后可以恢复。',
      okLabel: '确认叫停',
      okClass: 'btn-stop',
      onOk: (reason) => { setActionDialog(null); void doTaskAction('stop', reason); },
    });
  };

  const handleCancel = () => {
    if (actionBusy) return;
    setActionDialog({
      title: '取消任务',
      message: '确认取消 ' + task.id + '？\n\n任务会停止并标记为已取消，之后仍可选择恢复。',
      okLabel: '确认取消',
      okClass: 'btn-cancel',
      onOk: (reason) => { setActionDialog(null); void doTaskAction('cancel', reason); },
    });
  };

  // Scheduler state
  const sched = schedData?.scheduler;
  const stalledSec = schedData?.stalledSec || 0;
  const taskOpen = !['Done', 'Cancelled'].includes(task.state);
  const canRetryDispatch = taskOpen && task.state !== 'Blocked';
  const dispatchError = sched?.lastDispatchError || (task.state === 'Blocked' && task.block && task.block !== '无' && task.block !== '-' ? task.block : '');
  const dispatchStatus = schedData?.dispatchStatusLabel || (dispatchError ? '派发失败' : sched?.lastDispatchStatus === 'success' ? '已派发' : sched?.lastDispatchStatus === 'idle' ? '未开始派发' : sched?.lastDispatchStatus || '未派发');
  const dispatchStatusDetail = schedData?.dispatchStatusDetail || dispatchError || sched?.lastEvent || '';

  return (
    <div className="modal-bg open" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} aria-busy={actionBusy}>
        <button className="modal-close" onClick={close} disabled={actionBusy}>✕</button>
        <div className="modal-body">
          <div className="modal-id">{task.id}</div>
          <div className="modal-title">{task.title || '(无标题)'}</div>

          {/* Current Stage Banner */}
          {activeStage && (
            <div className="cur-stage">
              <div className="cs-icon">{activeStage.icon}</div>
              <div className="cs-info">
                <div className="cs-dept" style={{ color: deptColor(activeStage.dept) }}>{activeStage.dept}</div>
                <div className="cs-action">当前阶段：{activeStage.action}</div>
              </div>
              <span className={`hb ${hb.status} cs-hb`}>{hb.label}</span>
            </div>
          )}

          {/* Pipeline */}
          <div className="m-pipe">
            {stages.map((s, i) => (
              <div className="mp-stage" key={s.key}>
                <div className={`mp-node ${s.status}`}>
                  {s.status === 'done' && <div className="mp-done-tick">✓</div>}
                  <div className="mp-icon">{s.icon}</div>
                  <div className="mp-dept" style={s.status === 'active' ? { color: 'var(--acc)' } : s.status === 'done' ? { color: 'var(--ok)' } : {}}>
                    {s.dept}
                  </div>
                  <div className="mp-action">{s.action}</div>
                </div>
                {i < stages.length - 1 && (
                  <div className="mp-arrow" style={s.status === 'done' ? { color: 'var(--ok)', opacity: 0.6 } : {}}>→</div>
                )}
              </div>
            ))}
          </div>

          {/* Action Buttons */}
          <div className="task-actions" aria-label="任务操作">
            {actionBusy && <span className="async-action-status" role="status" aria-live="polite">⟳ {actionLabel || '正在执行操作…'}</span>}
            {canStop && (
              <>
                <button className="btn-action btn-stop" onClick={handleStop} disabled={actionBusy}>⏸ 叫停任务</button>
                <button className="btn-action btn-cancel" onClick={handleCancel} disabled={actionBusy}>🚫 取消任务</button>
              </>
            )}
            {!canStop && canCancel && (
              <button className="btn-action btn-cancel" onClick={handleCancel} disabled={actionBusy}>🚫 取消任务</button>
            )}
            {canResume && (
              <button className="btn-action btn-resume" onClick={() => void doTaskAction('resume', '恢复执行')} disabled={actionBusy}>▶️ 恢复执行</button>
            )}
            {['Review', 'Menxia'].includes(task.state) && (
              <>
                <button className="btn-action" style={{ background: '#2ecc8a22', color: '#2ecc8a', border: '1px solid #2ecc8a44' }} onClick={() => void doReview('approve')} disabled={actionBusy}>✅ 准奏</button>
                <button className="btn-action" style={{ background: '#ff527022', color: '#ff5270', border: '1px solid #ff527044' }} onClick={() => void doReview('reject')} disabled={actionBusy}>🚫 封驳</button>
              </>
            )}
            {['Pending', 'Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Doing', 'Review', 'Next'].includes(task.state) && (
              <button className="btn-action" style={{ background: '#7c5cfc18', color: '#7c5cfc', border: '1px solid #7c5cfc44' }} onClick={() => void doAdvance()} disabled={actionBusy}>⏩ 推进到下一步</button>
            )}
            {canDelete && (
              <button className="btn-action btn-cancel" onClick={handleDelete} disabled={actionBusy}>🗑 删除记录</button>
            )}
          </div>

          {dispatchError && <div className="task-dispatch-error" role="alert">
            <strong>派发未完成</strong>
            <span>{dispatchError}</span>
            {canResume && <button type="button" className="mini-act danger" onClick={() => void doTaskAction('resume', '恢复并重试派发')} disabled={actionBusy}>恢复并重试</button>}
          </div>}

          {/* Scheduler Section */}
          <div className="sched-section">
            <div className="sched-head">
              <span className="sched-title">🧭 太子调度</span>
              <span className="sched-status">
                {sched ? `${sched.enabled === false ? '已禁用' : '运行中'} · ${dispatchStatus} · 阈值 ${sched.stallThresholdSec || 180}s` : '加载中...'}
              </span>
            </div>
            <div className="sched-grid">
              <div className="sched-kpi"><div className="k">停滞时长</div><div className="v">{fmtStalled(stalledSec)}</div></div>
              <div className="sched-kpi"><div className="k">重试次数</div><div className="v">{sched?.retryCount || 0}</div></div>
              <div className="sched-kpi"><div className="k">升级级别</div><div className="v">{!sched?.escalationLevel ? '无' : sched.escalationLevel === 1 ? '门下省' : '尚书省'}</div></div>
              <div className="sched-kpi"><div className="k">派发状态</div><div className={`v ${dispatchError ? 'error' : ''}`}>{dispatchStatus}</div></div>
            </div>
            {sched && (
              <div className="sched-line">
                {sched.lastProgressAt && <span>最近进展 {formatDashboardDateTime(sched.lastProgressAt)}</span>}
                {sched.lastDispatchAt && <span>最近派发 {formatDashboardDateTime(sched.lastDispatchAt)}</span>}
                <span>自动回滚 {sched.autoRollback === false ? '关闭' : '开启'}</span>
                {sched.lastDispatchAgent && <span>目标 {sched.lastDispatchAgent}</span>}
                {sched.lastDispatchMode && <span>方式 {sched.lastDispatchMode === 'local' ? '本地' : sched.lastDispatchMode === 'gateway' ? 'Gateway' : sched.lastDispatchMode}</span>}
              </div>
            )}
            {dispatchStatusDetail && <div className="sched-dispatch-detail">{dispatchStatusDetail}</div>}
            <div className="sched-actions">
              {canRetryDispatch && <button className="sched-btn" onClick={() => void doSchedAction('retry')} disabled={actionBusy}>🔁 重试派发</button>}
              {taskOpen && <button className="sched-btn warn" onClick={() => void doSchedAction('escalate')} disabled={actionBusy}>📣 升级协调</button>}
              {taskOpen && <button className="sched-btn danger" onClick={() => void doSchedAction('rollback')} disabled={actionBusy}>↩️ 回滚稳定点</button>}
              {taskOpen && <button className="sched-btn" onClick={() => void doSchedAction('scan')} disabled={actionBusy}>🔍 立即扫描</button>}
            </div>
          </div>

          {/* Todo List */}
          {todoTotal > 0 && (
            <TodoSection todos={todos} todoDone={todoDone} todoTotal={todoTotal} />
          )}

          {/* Basic Info */}
          <div className="m-section">
            <div className="m-rows">
              <div className="m-row">
                <div className="mr-label">状态</div>
                <div className="mr-val">
                  <span className={`tag st-${task.state}`}>{stateLabel(task)}</span>
                  {(task.review_round || 0) > 0 && <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>共磋商 {task.review_round} 轮</span>}
                </div>
              </div>
              <div className="m-row">
                <div className="mr-label">执行部门</div>
                <div className="mr-val"><span className={`tag dt-${(task.org || '').replace(/\s/g, '')}`}>{task.org || '—'}</span></div>
              </div>
              {task.targetDept && (
                <div className="m-row">
                  <div className="mr-label">六部目标</div>
                  <div className="mr-val"><span className="tag dt-六部">{task.targetDept}</span></div>
                </div>
              )}
              {task.eta && task.eta !== '-' && (
                <div className="m-row"><div className="mr-label">预计完成</div><div className="mr-val">{task.eta}</div></div>
              )}
              {task.block && task.block !== '无' && task.block !== '-' && (
                <div className="m-row"><div className="mr-label" style={{ color: 'var(--danger)' }}>阻塞项</div><div className="mr-val" style={{ color: 'var(--danger)' }}>{task.block}</div></div>
              )}
              {task.now && task.now !== '-' && (
                <div className="m-row" style={{ gridColumn: '1/-1' }}>
                  <div className="mr-label">当前进展</div>
                  <div className="mr-val" style={{ fontWeight: 400, fontSize: 12 }}>{task.now}</div>
                </div>
              )}
              {task.ac && (
                <div className="m-row" style={{ gridColumn: '1/-1' }}>
                  <div className="mr-label">验收标准</div>
                  <div className="mr-val" style={{ fontWeight: 400, fontSize: 12 }}>{task.ac}</div>
                </div>
              )}
            </div>
          </div>

          {/* Flow Log */}
          {flowLog.length > 0 && (
            <div className="m-section">
              <div className="m-sec-label">流转日志（{flowLog.length} 条）</div>
              <div className="fl-timeline">
                {flowLog.map((fl, i) => {
                  const col = deptColor(fl.from || '');
                  return (
                    <div className="fl-item" key={i}>
                      <div className="fl-time">{formatDashboardTime(fl.at, { showSeconds: false })}</div>
                      <div className="fl-dot" style={{ background: col }} />
                      <div className="fl-content">
                        <div className="fl-who">
                          <span className="from" style={{ color: col }}>{fl.from}</span>
                          <span style={{ color: 'var(--muted)' }}> → </span>
                          <span className="to" style={{ color: deptColor(fl.to || '') }}>{fl.to}</span>
                        </div>
                        <div className="fl-rem">{fl.remark}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Output */}
          {task.output && task.output !== '-' && task.output !== '' && (
            <div className="m-section">
              <div className="m-sec-label">产出物</div>
              <code>{task.output}</code>
            </div>
          )}

          {/* Live Activity */}
          <LiveActivitySection data={activityData} isDone={['Done', 'Cancelled'].includes(task.state)} logRef={logRef} />
        </div>
      </div>
      {actionDialog && <ConfirmDialog {...actionDialog} onCancel={() => setActionDialog(null)} />}
    </div>
  );
}

function TodoSection({ todos, todoDone, todoTotal }: { todos: TodoItem[]; todoDone: number; todoTotal: number }) {
  return (
    <div className="todo-section">
      <div className="todo-header">
        <div className="m-sec-label" style={{ marginBottom: 0, border: 'none', padding: 0 }}>
          子任务清单（{todoDone}/{todoTotal}）
        </div>
        <div className="todo-progress">
          <div className="todo-bar">
            <div className="todo-bar-fill" style={{ width: `${Math.round((todoDone / todoTotal) * 100)}%` }} />
          </div>
          <span>{Math.round((todoDone / todoTotal) * 100)}%</span>
        </div>
      </div>
      <div className="todo-list">
        {todos.map((td) => {
          const ico = td.status === 'completed' ? '✅' : td.status === 'in-progress' ? '🔄' : '⬜';
          const stLabel = td.status === 'completed' ? '已完成' : td.status === 'in-progress' ? '进行中' : '待开始';
          const stCls = td.status === 'completed' ? 's-done' : td.status === 'in-progress' ? 's-progress' : 's-notstarted';
          const itemCls = td.status === 'completed' ? 'done' : '';
          return (
            <div className={`todo-item ${itemCls}`} key={td.id}>
              <div className="t-row">
                <span className="t-icon">{ico}</span>
                <span className="t-id">#{td.id}</span>
                <span className="t-title">{td.title}</span>
                <span className={`t-status ${stCls}`}>{stLabel}</span>
              </div>
              {td.detail && <div className="todo-detail">{td.detail}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiveActivitySection({
  data,
  isDone,
  logRef,
}: {
  data: TaskActivityData | null;
  isDone: boolean;
  logRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (!data) return null;

  const activity = data.activity || [];
  const isActive = (() => {
    if (!activity.length) return false;
    const last = activity[activity.length - 1];
    if (!last.at) return false;
    const ts = typeof last.at === 'number' ? last.at : new Date(last.at).getTime();
    return Date.now() - ts < 300000;
  })();

  const agentParts: string[] = [];
  if (data.agentLabel) agentParts.push(data.agentLabel);
  if (data.relatedAgents && data.relatedAgents.length > 1) agentParts.push(`${data.relatedAgents.length}个 Agent`);
  if (data.lastActive) agentParts.push(`最后活跃: ${formatDashboardDateTime(data.lastActive)}`);

  // Phase durations
  const phaseDurations = data.phaseDurations || [];
  const maxDur = Math.max(...phaseDurations.map((p) => p.durationSec || 1), 1);
  const phaseColors: Record<string, string> = {
    '皇上': '#eab308', '太子': '#f97316', '中书省': '#3b82f6', '门下省': '#8b5cf6',
    '尚书省': '#10b981', '六部': '#06b6d4', '礼部': '#ec4899', '户部': '#f59e0b',
    '兵部': '#ef4444', '刑部': '#6366f1', '工部': '#14b8a6', '吏部': '#d946ef',
  };

  // Todos summary
  const ts = data.todosSummary;

  // Resource summary
  const rs = data.resourceSummary;

  // Group non-flow activity by agent
  const flowItems = activity.filter((a) => a.kind === 'flow' && !a.scheduler);
  const nonFlow = activity.filter((a) => a.kind !== 'flow' && !a.scheduler);
  const grouped = new Map<string, ActivityEntry[]>();
  nonFlow.forEach((a) => {
    const key = a.agent || 'unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(a);
  });

  return (
    <div className="la-section">
      <div className="la-header">
        <span className="la-title">
          <span className={`la-dot${isActive ? '' : ' idle'}`} />
          {isDone ? '执行回顾' : '实时动态'}
        </span>
        <span className="la-agent">{agentParts.join(' · ') || '加载中...'}</span>
      </div>

      {/* Phase Bars */}
      {phaseDurations.length > 0 && (
        <div style={{ padding: '4px 0 8px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>⏱ 阶段耗时</span>
            {data.totalDuration && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' }}>总耗时 {data.totalDuration}</span>}
          </div>
          {phaseDurations.map((p, i) => {
            const pct = Math.max(5, Math.round(((p.durationSec || 1) / maxDur) * 100));
            const color = phaseColors[p.phase] || '#6b7280';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0', fontSize: 11 }}>
                <span style={{ minWidth: 48, color: 'var(--muted)', textAlign: 'right' }}>{p.phase}</span>
                <div style={{ flex: 1, height: 14, background: 'var(--panel)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, opacity: p.ongoing ? 0.6 : 0.85 }} />
                </div>
                <span style={{ minWidth: 60, fontSize: 10, color: 'var(--muted)' }}>
                  {p.durationText}
                  {p.ongoing && <span style={{ fontSize: 9, color: '#60a5fa' }}> ●进行中</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Todos Progress */}
      {ts && (
        <div style={{ padding: '4px 0 8px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>📊 执行进度</span>
            <span style={{ fontSize: 20, fontWeight: 700, color: ts.percent >= 100 ? '#22c55e' : ts.percent >= 50 ? '#60a5fa' : 'var(--text)' }}>{ts.percent}%</span>
            <span style={{ fontSize: 10, color: 'var(--muted)' }}>✅{ts.completed} 🔄{ts.inProgress} ⬜{ts.notStarted} / 共{ts.total}项</span>
          </div>
          <div style={{ height: 8, background: 'var(--panel)', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
            <div style={{ width: `${ts.total ? (ts.completed / ts.total) * 100 : 0}%`, background: '#22c55e' }} />
            <div style={{ width: `${ts.total ? (ts.inProgress / ts.total) * 100 : 0}%`, background: '#3b82f6' }} />
          </div>
        </div>
      )}

      {/* Resource Summary */}
      {rs && (rs.totalTokens || rs.totalCost) && (
        <div style={{ padding: '4px 0 8px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>📈 资源消耗</span>
          {rs.totalTokens != null && <span style={{ fontSize: 11, color: 'var(--muted)' }}>🔢 {rs.totalTokens.toLocaleString()} tokens</span>}
          {rs.totalCost != null && <span style={{ fontSize: 11, color: 'var(--muted)' }}>💰 ${rs.totalCost.toFixed(4)}</span>}
          {rs.totalElapsedSec != null && (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              ⏳ {rs.totalElapsedSec >= 60 ? `${Math.floor(rs.totalElapsedSec / 60)}分` : ''}{rs.totalElapsedSec % 60}秒
            </span>
          )}
        </div>
      )}

      {/* Activity Log */}
      <div className="la-log" ref={logRef as React.RefObject<HTMLDivElement>}>
        {/* Flow entries */}
        {flowItems.length > 0 && (
          <div className="la-flow-wrap">
            {flowItems.map((a, i) => (
              <div className="la-entry la-tool" key={`flow-${i}`}>
                <span className="la-icon">📋</span>
                <span className="la-body"><b>{a.from}</b> → <b>{a.to}</b>　{a.remark || ''}</span>
                <span className="la-time">{fmtActivityTime(a.at)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Grouped entries */}
        {grouped.size > 0 ? (
          <div className="la-groups">
            {Array.from(grouped.entries()).map(([agent, items]) => {
              const label = AGENT_LABELS[agent] || agent || '未标识';
              const last = items[items.length - 1];
              const lastTime = last?.at ? fmtActivityTime(last.at) : '--:--:--';
              return (
                <div className="la-group" key={agent}>
                  <div className="la-group-hd">
                    <span className="name">{label}</span>
                    <span>最近更新 {lastTime}</span>
                  </div>
                  <div className="la-group-bd">
                    {items.map((a, i) => (
                      <ActivityEntryView key={i} entry={a} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          !flowItems.length && (
            <div className="la-empty">
              {data.message || data.error || 'Agent 尚未上报进展（等待 Agent 调用 progress 命令）'}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function ActivityEntryView({ entry: a }: { entry: ActivityEntry }) {
  const time = fmtActivityTime(a.at);
  const agBadge = a.agent ? (
    <span style={{ fontSize: 9, color: 'var(--muted)', background: 'var(--panel)', padding: '1px 4px', borderRadius: 3, marginRight: 4 }}>
      {AGENT_LABELS[a.agent] || a.agent}
    </span>
  ) : null;

  if (a.kind === 'progress') {
    return (
      <div className="la-entry la-assistant">
        <span className="la-icon">🔄</span>
        <span className="la-body">{agBadge}<b>当前进展：</b>{a.text}</span>
        <span className="la-time">{time}</span>
      </div>
    );
  }

  if (a.kind === 'todos') {
    const items = a.items || [];
    const diffMap = new Map<string, { type: string; from?: string; to?: string }>();
    if (a.diff) {
      (a.diff.changed || []).forEach((c) => diffMap.set(c.id, { type: 'changed', from: c.from, to: c.to }));
      (a.diff.added || []).forEach((c) => diffMap.set(c.id, { type: 'added' }));
    }
    return (
      <div className="la-entry" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>{agBadge}📝 执行计划</div>
        {items.map((td) => {
          const icon = td.status === 'completed' ? '✅' : td.status === 'in-progress' ? '🔄' : '⬜';
          const d = diffMap.get(String(td.id));
          const style: React.CSSProperties = td.status === 'completed'
            ? { opacity: 0.5, textDecoration: 'line-through' }
            : td.status === 'in-progress'
              ? { color: '#60a5fa', fontWeight: 'bold' }
              : {};
          return (
            <div key={td.id} style={style}>
              {icon} {td.title}
              {d && d.type === 'changed' && d.to === 'completed' && <span style={{ color: '#22c55e', fontSize: 9, marginLeft: 4 }}>✨刚完成</span>}
              {d && d.type === 'changed' && d.to !== 'completed' && <span style={{ color: '#f59e0b', fontSize: 9, marginLeft: 4 }}>↻{d.from}→{d.to}</span>}
              {d && d.type === 'added' && <span style={{ color: '#3b82f6', fontSize: 9, marginLeft: 4 }}>🆕新增</span>}
            </div>
          );
        })}
        {a.diff?.removed?.map((r) => (
          <div key={r.id} style={{ opacity: 0.4, textDecoration: 'line-through' }}>🗑 {r.title}</div>
        ))}
      </div>
    );
  }

  if (a.kind === 'assistant') {
    return (
      <>
        {a.thinking && (
          <div className="la-entry la-thinking">
            <span className="la-icon">💭</span>
            <span className="la-body">{agBadge}{a.thinking}</span>
            <span className="la-time">{time}</span>
          </div>
        )}
        {a.tools?.map((tc, i) => (
          <div className="la-entry la-tool" key={i}>
            <span className="la-icon">🔧</span>
            <span className="la-body">{agBadge}<span className="la-tool-name">{tc.name}</span><span className="la-trunc">{tc.input_preview || ''}</span></span>
            <span className="la-time">{time}</span>
          </div>
        ))}
        {a.text && (
          <div className="la-entry la-assistant">
            <span className="la-icon">🤖</span>
            <span className="la-body">{agBadge}{a.text}</span>
            <span className="la-time">{time}</span>
          </div>
        )}
      </>
    );
  }

  if (a.kind === 'tool_result') {
    const ok = a.exitCode === 0 || a.exitCode === null || a.exitCode === undefined;
    return (
      <div className={`la-entry la-tool-result ${ok ? 'ok' : 'err'}`}>
        <span className="la-icon">{ok ? '✅' : '❌'}</span>
        <span className="la-body">{agBadge}<span className="la-tool-name">{a.tool || ''}</span>{a.output ? a.output.substring(0, 150) : ''}</span>
        <span className="la-time">{time}</span>
      </div>
    );
  }

  if (a.kind === 'user') {
    return (
      <div className="la-entry la-user">
        <span className="la-icon">📥</span>
        <span className="la-body">{agBadge}{a.text || ''}</span>
        <span className="la-time">{time}</span>
      </div>
    );
  }

  return null;
}
