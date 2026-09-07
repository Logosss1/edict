import { useEffect, useMemo, useState } from 'react';
import { FileCode2, FolderOpen, GitBranch, LoaderCircle, Play, RefreshCw, Square, TestTube2 } from 'lucide-react';
import { api, type TaskWorkspaceData, type WorkspaceTestRun } from '../api';
import { isArchived, isEdict, useStore } from '../store';

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function runLabel(run: WorkspaceTestRun | null | undefined): string {
  if (!run) return '尚未运行测试';
  if (run.status === 'running') return '测试运行中';
  if (run.status === 'passed') return '测试通过';
  if (run.status === 'timeout') return '测试超时';
  return '测试失败';
}

export default function ExecutionInspector() {
  const liveStatus = useStore((state) => state.liveStatus);
  const toast = useStore((state) => state.toast);
  const tasks = useMemo(
    () => (liveStatus?.tasks || []).filter((task) => !isArchived(task) && !['Done', 'Cancelled'].includes(task.state)),
    [liveStatus],
  );
  const [selectedId, setSelectedId] = useState('');
  const [data, setData] = useState<TaskWorkspaceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (selectedId && tasks.some((task) => task.id === selectedId)) return;
    setSelectedId(tasks[0]?.id || '');
  }, [selectedId, tasks]);

  const refresh = async (quiet = false) => {
    if (!selectedId) {
      setData(null);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      setData(await api.taskWorkspace(selectedId));
    } catch (reason) {
      if (!quiet) toast(reason instanceof Error ? reason.message : '执行详情读取失败', 'err');
      setData(null);
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    if (!selectedId) return;
    const timer = window.setInterval(() => void refresh(true), 3000);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  const runTest = async () => {
    if (!selectedId || running) return;
    setRunning(true);
    try {
      const commandId = data?.testCommands?.[0]?.id;
      const result = await api.runTaskTest(selectedId, commandId);
      if (!result.ok) toast(result.error || '测试未能启动', 'err');
      else toast(result.message || '测试已启动');
      await refresh();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : '测试启动失败', 'err');
    } finally {
      setRunning(false);
    }
  };

  const cancelTest = async () => {
    const run = data?.latestTest;
    if (!run || run.status !== 'running') return;
    const result = await api.cancelTaskTest(run.id);
    if (result.ok) toast(result.message || '已请求停止测试');
    else toast(result.error || '停止测试失败', 'err');
    await refresh();
  };

  return (
    <aside className="execution-inspector" aria-label="当前任务执行详情">
      <div className="inspector-heading">
        <span>执行详情</span>
        <button className="inspector-icon-button" type="button" onClick={() => void refresh()} disabled={loading || !selectedId} aria-label="刷新执行详情" title="刷新执行详情">
          {loading ? <LoaderCircle className="guard-spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="execution-inspector-kicker">当前任务</div>
      {tasks.length > 0 ? (
        <div className="execution-task-list">
          {tasks.map((task) => (
            <button key={task.id} type="button" className={selectedId === task.id ? 'selected' : ''} onClick={() => setSelectedId(task.id)}>
              <small>{task.id}</small>
              <strong>{task.title || '(无标题)'}</strong>
              <span>{isEdict(task) ? `旨意 · ${task.org || task.state}` : `小任务 · ${task.org || task.state}`}</span>
            </button>
          ))}
        </div>
      ) : <p className="inspector-empty">暂无进行中的任务。先从运行页向太子下达一条指令。</p>}

      {data?.task && <>
        <section className="execution-inspector-section" aria-labelledby="execution-current-title">
          <div className="execution-inspector-section-title" id="execution-current-title">阶段与权限</div>
          <div className="execution-current-state">
            <strong>{data.task.org || data.task.state}</strong>
            <span>{data.task.state} · {data.task.targetAgent || '等待明确 Agent'}</span>
          </div>
          <p className="execution-scope"><span>访问模式</span>{data.permission?.mode || 'full'} · 当前项目内读写、运行测试</p>
          <p className="execution-scope" title={data.projectPath}><FolderOpen size={13} />{data.projectPath || '未绑定项目'}</p>
          {data.task.now && <p className="execution-now">{data.task.now}</p>}
          {data.task.block && data.task.block !== '无' && <p className="execution-block">{data.task.block}</p>}
        </section>

        <section className="execution-inspector-section" aria-labelledby="execution-changes-title">
          <div className="execution-inspector-section-title" id="execution-changes-title"><GitBranch size={13} />Git 变更</div>
          {data.git?.available ? <>
            <p className="execution-branch">{data.git.branch || '未命名分支'}</p>
            <p className="execution-summary">{data.git.summary || '工作区干净'}</p>
            {data.git.changedFiles.length > 0 ? <ul className="execution-file-list">{data.git.changedFiles.slice(0, 12).map((file) => <li key={file}><FileCode2 size={12} />{file}</li>)}</ul> : <p className="inspector-empty">暂无未提交变更</p>}
          </> : <p className="inspector-empty">{data.git?.summary || '当前目录不是 Git 仓库'}</p>}
        </section>

        <section className="execution-inspector-section" aria-labelledby="execution-output-title">
          <div className="execution-inspector-section-title" id="execution-output-title">产出文件</div>
          <p className="execution-output-path" title={data.outputDir}>{data.outputDir || 'Edict_Output/任务ID'}</p>
          {data.artifacts.length > 0 ? <ul className="execution-file-list">{data.artifacts.slice(0, 12).map((file) => <li key={file.path}><FileCode2 size={12} /><span title={file.path}>{file.name}</span><small>{formatSize(file.size)}</small></li>)}</ul> : <p className="inspector-empty">Agent 尚未在输出目录产生文件。</p>}
        </section>

        <section className="execution-inspector-section" aria-labelledby="execution-test-title">
          <div className="execution-inspector-section-title" id="execution-test-title"><TestTube2 size={13} />快速测试</div>
          <div className="execution-test-actions">
            <span>{data.testCommands?.[0]?.label || '未检测到测试命令'}</span>
            {data.latestTest?.status === 'running' ? <button className="btn btn-danger" type="button" onClick={() => void cancelTest()}><Square size={12} />停止</button> : <button className="btn btn-g" type="button" disabled={running || !data.testCommands?.[0]?.id} onClick={() => void runTest()}>{running ? <LoaderCircle className="guard-spin" size={12} /> : <Play size={12} />}运行</button>}
          </div>
          {data.latestTest && <div className={`execution-test-result ${data.latestTest.status}`} role="status"><strong>{runLabel(data.latestTest)}</strong>{data.latestTest.exitCode !== null && data.latestTest.exitCode !== undefined && <span>退出码 {data.latestTest.exitCode}</span>}<pre>{data.latestTest.output || '等待测试输出…'}</pre></div>}
        </section>

        <section className="execution-inspector-section" aria-labelledby="execution-activity-title">
          <div className="execution-inspector-section-title" id="execution-activity-title">最近活动</div>
          {data.activity && data.activity.length > 0 ? <ul className="execution-activity-list">{data.activity.slice(-6).map((item, index) => <li key={`${item.at}-${index}`}><span>{item.agent || item.kind}</span><p>{item.text || item.remark || item.output || item.tool || '活动已记录'}</p></li>)}</ul> : <p className="inspector-empty">等待 Agent 写入活动。</p>}
        </section>
      </>}
    </aside>
  );
}
