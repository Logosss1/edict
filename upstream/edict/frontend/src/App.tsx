import { useEffect, useState } from 'react';
import { FolderOpen, Monitor, PanelRightClose, PanelRightOpen, Settings2, Sparkles } from 'lucide-react';
import { api, type ReadinessData } from './api';
import { useStore, TAB_DEFS, startPolling, stopPolling, isEdict, isArchived } from './store';
import EdictBoard from './components/EdictBoard';
import MonitorPanel from './components/MonitorPanel';
import OfficialPanel from './components/OfficialPanel';
import ModelConfig from './components/ModelConfig';
import SkillsConfig from './components/SkillsConfig';
import SessionsPanel from './components/SessionsPanel';
import MemorialPanel from './components/MemorialPanel';
import TemplatePanel from './components/TemplatePanel';
import MorningPanel from './components/MorningPanel';
import TaskModal from './components/TaskModal';
// ConfirmDialog is used inside TaskModal as needed
import Toaster from './components/Toaster';
import CourtCeremony from './components/CourtCeremony';
import CourtDiscussion from './components/CourtDiscussion';
import ExecutionGuardPanel from './components/ExecutionGuardPanel';
import Yushufang from './components/Yushufang';
import ExecutionInspector from './components/ExecutionInspector';

export default function App() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const liveStatus = useStore((s) => s.liveStatus);
  const countdown = useStore((s) => s.countdown);
  const loadAll = useStore((s) => s.loadAll);
  const [readiness, setReadiness] = useState<ReadinessData | null>(null);
  const [workspaceState, setWorkspaceState] = useState<EdictDesktopWorkspaceState | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  const refreshWorkspace = async () => {
    try {
      const state = await window.edictDesktop?.getWorkspaceState?.();
      if (state) setWorkspaceState(state);
    } catch {
      // An older embedded preload should not make the existing dashboard unusable.
    }
  };

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, []);

  useEffect(() => {
    void refreshWorkspace();
    const timer = window.setInterval(() => void refreshWorkspace(), 8000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const bridge = (window as Window & { edictDesktop?: { onModelSettings?: (callback: () => void) => () => void } }).edictDesktop;
    return bridge?.onModelSettings?.(() => setActiveTab('models'));
  }, [setActiveTab]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const result = await api.readiness();
        if (mounted) setReadiness(result);
      } catch {
        // The existing sync chip remains the source of truth when the
        // readiness endpoint is not reachable yet.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 6000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  // Compute header chips
  const tasks = liveStatus?.tasks || [];
  const edicts = tasks.filter(isEdict);
  const activeEdicts = edicts.filter((t) => !isArchived(t));
  const sync = liveStatus?.syncStatus;
  const syncOk = sync?.ok;
  const activeWorkspace = workspaceState?.activeWorkspace;
  const activeTasks = tasks.filter((task) => isEdict(task) && !isArchived(task) && !['Done', 'Cancelled'].includes(task.state));
  const currentNav = activeTab === 'memorials' ? 'archive' : activeTab === 'skills' ? 'skills' : activeTab === 'preflight' ? 'guard' : activeTab === 'monitor' ? 'monitor' : 'run';

  const openSettings = (tab?: string) => void window.edictDesktop?.openSettings?.(tab);
  const openWorkspacePermissions = () => void window.edictDesktop?.openWorkspacePermissions?.();
  const switchWorkspace = async (id: string) => {
    if (!id || id === workspaceState?.activeWorkspaceId) return;
    await window.edictDesktop?.activateWorkspace?.(id);
  };
  const addProject = async () => {
    await window.edictDesktop?.chooseProject?.();
    await refreshWorkspace();
  };

  const navItems = [
    { id: 'run', label: '运行', icon: <Sparkles size={15} aria-hidden="true" />, onClick: () => setActiveTab('edicts') },
    { id: 'guard', label: '执行保障', icon: <span className="nav-text-icon" aria-hidden="true">盾</span>, onClick: () => setActiveTab('preflight') },
    { id: 'archive', label: '档案', icon: <span className="nav-text-icon" aria-hidden="true">档</span>, onClick: () => setActiveTab('memorials') },
    { id: 'skills', label: 'Skills & MCP', icon: <span className="nav-text-icon" aria-hidden="true">S</span>, onClick: () => setActiveTab('skills') },
    { id: 'monitor', label: '执行监控', icon: <Monitor size={15} aria-hidden="true" />, onClick: () => setActiveTab('monitor') },
    { id: 'settings', label: '设置', icon: <Settings2 size={15} aria-hidden="true" />, onClick: () => openSettings() },
  ];

  // Tab badge counts
  const tabBadge = (key: string): string => {
    if (key === 'edicts') return String(activeEdicts.length);
    if (key === 'sessions') return String(tasks.filter((t) => !isEdict(t)).length);
    if (key === 'memorials') return String(edicts.filter((t) => ['Done', 'Cancelled'].includes(t.state)).length);
    if (key === 'monitor') {
      const activeDepts = tasks.filter((t) => isEdict(t) && t.state === 'Doing').length;
      return activeDepts + '活跃';
    }
    return '';
  };

  return (
    <div className="wrap app-shell">
      {/* ── Header ── */}
      <div className="hdr">
        <div>
          <div className="logo">Edict_InnerCourt</div>
          <div className="sub-text">三省六部 · 总控台</div>
        </div>
        <div className="hdr-r">
          <span className={`chip ${syncOk ? 'ok' : syncOk === false ? 'err' : ''}`}>
            {syncOk ? '✅ 同步正常' : syncOk === false ? '❌ 服务器未启动' : '⏳ 连接中…'}
          </span>
          <span className="chip">{activeEdicts.length} 道旨意</span>
          <button className="btn-refresh" onClick={() => loadAll()}>
            ⟳ 刷新
          </button>
          <button className="btn-refresh inspector-toggle" type="button" onClick={() => setInspectorOpen((open) => !open)} aria-expanded={inspectorOpen} aria-controls="execution-inspector">
            {inspectorOpen ? <PanelRightClose size={14} aria-hidden="true" /> : <PanelRightOpen size={14} aria-hidden="true" />} {inspectorOpen ? '隐藏执行详情' : '显示执行详情'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>⟳ {countdown}s</span>
        </div>
      </div>

      <section className="workspace-context" aria-label="当前工作区">
        <div className="workspace-context-main">
          <div className="workspace-context-title"><FolderOpen size={16} aria-hidden="true" />{activeWorkspace?.name || '当前工作区'}</div>
          <div className="workspace-context-path" title={activeWorkspace?.projectPath || activeWorkspace?.path || ''}>
            项目 · {activeWorkspace?.projectPath || '未绑定项目'}
          </div>
        </div>
        <div className="workspace-context-actions">
          {workspaceState && workspaceState.workspaces.length > 0 && <label className="workspace-switcher">
            <span className="sr-only">切换工作区</span>
            <select aria-label="切换工作区" value={workspaceState.activeWorkspaceId || ''} onChange={(event) => void switchWorkspace(event.target.value)}>
              {workspaceState.workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>}
          <button className="workbench-action" type="button" onClick={() => void window.edictDesktop?.chooseWorkspace?.('existing')}>切换工作区</button>
          <button className="workbench-action" type="button" onClick={() => void addProject()}>更换项目</button>
        </div>
      </section>

      <div className={`workbench-grid${inspectorOpen ? '' : ' inspector-closed'}`}>
        <aside className="workbench-rail" aria-label="工作台导航">
          <nav className="app-global-nav" aria-label="应用导航">
            {navItems.map((item) => <button key={item.id} type="button" className={`app-global-nav-item ${currentNav === item.id ? 'active' : ''}`} onClick={item.onClick}>
              {item.icon}<span>{item.label}</span>
            </button>)}
          </nav>
          <div className="rail-label">当前项目</div>
          <div className="rail-project">{activeWorkspace?.projectPath ? activeWorkspace.projectPath.split('/').pop() : '未绑定项目'}</div>
          <button className={`rail-link ${activeTab === 'edicts' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('edicts')}>任务运行 <span>{activeTasks.length}</span></button>
          <button className={`rail-link ${activeTab === 'yushufang' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('yushufang')}>实时问询</button>
          <div className="rail-divider" />
          <div className="rail-label">三省六部</div>
          <div className="rail-flow"><span>太子</span><span>中书省</span><span>门下省</span><span>尚书省</span><span>六部</span><span>回奏</span></div>
          <button className="rail-link" type="button" onClick={() => openSettings()}>供应商与模型 <span>设置</span></button>
          <button className={`rail-link ${activeTab === 'preflight' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('preflight')}>执行保障 <span>检测</span></button>
        </aside>

        <main className="workbench-main">
          <div className="tabs" role="tablist" aria-label="三省六部详细页面">
            {TAB_DEFS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-label={t.label}
                aria-selected={activeTab === t.key}
                className={`tab ${activeTab === t.key ? 'active' : ''}`}
                onClick={() => setActiveTab(t.key)}
              >
                {t.icon} {t.label}
                {tabBadge(t.key) && <span className="tbadge">{tabBadge(t.key)}</span>}
              </button>
            ))}
          </div>

          {readiness && !readiness.ready && <section className="readiness-banner" role="status" aria-label="开工体检状态">
            <div className="readiness-copy">
              <strong>开工体检未通过</strong>
              <span>{readiness.next || '请先修复下面列出的运行环境问题。'}</span>
              {readiness.checks.filter((check) => !check.ready).length > 0 && <ul>
                {readiness.checks.filter((check) => !check.ready).map((check) => <li key={check.id}>{check.label}：{check.detail}</li>)}
              </ul>}
            </div>
            <div className="readiness-actions">
              <button className="btn btn-p" type="button" onClick={() => setActiveTab('preflight')}>打开执行保障</button>
              {readiness.checks.some((check) => check.id === 'workspace' && !check.ready) && window.edictDesktop?.openWorkspacePermissions && <button className="btn btn-g" type="button" onClick={openWorkspacePermissions}>打开 macOS 权限设置</button>}
              {window.edictDesktop?.openSettings && <button className="btn btn-g" type="button" onClick={() => openSettings()}>打开设置完成配置</button>}
            </div>
          </section>}

          {activeTab === 'edicts' && <EdictBoard />}
          {activeTab === 'preflight' && <ExecutionGuardPanel initialReadiness={readiness} onSelectTab={setActiveTab} />}
          {activeTab === 'court' && <CourtDiscussion />}
          {activeTab === 'yushufang' && <Yushufang />}
          {activeTab === 'monitor' && <MonitorPanel />}
          {activeTab === 'officials' && <OfficialPanel />}
          {activeTab === 'models' && <ModelConfig />}
          {activeTab === 'skills' && <SkillsConfig />}
          {activeTab === 'sessions' && <SessionsPanel />}
          {activeTab === 'memorials' && <MemorialPanel />}
          {activeTab === 'templates' && <TemplatePanel />}
          {activeTab === 'morning' && <MorningPanel />}
        </main>

        {inspectorOpen ? <div id="execution-inspector"><ExecutionInspector /></div> : <aside className="workbench-inspector-collapsed" aria-label="当前协同状态"><PanelRightOpen size={18} /><span>执行详情已隐藏</span><button type="button" className="workbench-action" onClick={() => setInspectorOpen(true)}>打开</button></aside>}
      </div>

      {/* ── Overlays ── */}
      <TaskModal />
      <Toaster />
      <CourtCeremony />
    </div>
  );
}
