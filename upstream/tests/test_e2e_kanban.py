#!/usr/bin/env python3
"""端到端测试 kanban_update.py 的清洗+创建+流转全流程

既可以 pytest 运行，也可以 python3 直接运行。
"""
import sys, pathlib, pytest

# 切换到 scripts 目录（file_lock 依赖）
_SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(_SCRIPTS_DIR))

import kanban_update
from kanban_update import (
    _sanitize_title, _sanitize_remark, _is_valid_task_title,
    cmd_create, cmd_flow, cmd_state, cmd_done, load,
)


def _get_task(tid):
    return next((x for x in load() if x['id'] == tid), None)


@pytest.fixture(autouse=True)
def _isolated_tasks(tmp_path, monkeypatch):
    """Tests never overwrite the workspace's task data or start refresh children."""
    task_file = tmp_path / 'tasks_source.json'
    task_file.write_text('[]')
    monkeypatch.setattr(kanban_update, 'TASKS_FILE', task_file)
    monkeypatch.setattr(kanban_update, '_trigger_refresh', lambda: None)
    monkeypatch.setattr(kanban_update, '_append_audit', lambda *_args: None)


# ── TEST 1: 脏标题(含文件路径+Conversation)应被清洗后创建
def test_dirty_title_cleaned():
    cmd_create('JJC-TEST-E2E-01',
         '全面审查/path/to/project/这个项目\nConversation info (xxx)',
        'Zhongshu', '中书省', '中书令',
         '下旨（自动预建）：全面审查/path/to/project/项目')
    t = _get_task('JJC-TEST-E2E-01')
    assert t is not None, "任务应被创建"
    assert '/Users' not in t['title'], f"标题不应含路径: {t['title']}"
    assert 'Conversation' not in t['title'], f"标题不应含Conversation: {t['title']}"
    assert '自动预建' not in t['flow_log'][0]['remark'], f"remark不应含自动预建: {t['flow_log'][0]['remark']}"
    assert '/Users' not in t['flow_log'][0]['remark'], f"remark不应含路径: {t['flow_log'][0]['remark']}"


# ── TEST 2: 纯文件路径标题被拒绝
def test_pure_path_rejected():
    cmd_create('JJC-TEST-E2E-02', '/path/to/project/', 'Zhongshu', '中书省', '中书令')
    assert _get_task('JJC-TEST-E2E-02') is None, "纯路径标题应被拒绝"


# ── TEST 3: 正常标题正常创建
def test_normal_title():
    cmd_create('JJC-TEST-E2E-03', '调研工业数据分析大模型应用方案', 'Zhongshu', '中书省', '中书令', '太子整理旨意')
    t = _get_task('JJC-TEST-E2E-03')
    assert t is not None, "正常任务应被创建"
    assert t['title'] == '调研工业数据分析大模型应用方案', f"标题应完整保留: {t['title']}"


# ── TEST 4: flow remark 清洗
def test_flow_remark_cleaned():
    cmd_create('JJC-TEST-E2E-04', '调研工业数据分析大模型应用方案', 'Zhongshu', '中书省', '中书令')
    cmd_flow('JJC-TEST-E2E-04', '太子', '中书省', '旨意传达：审查/path/to/project/xxx项目 Conversation blah')
    t = _get_task('JJC-TEST-E2E-04')
    assert t is not None
    last_flow = t['flow_log'][-1]
    assert '/Users' not in last_flow['remark'], f"remark不应含路径: {last_flow['remark']}"
    assert 'Conversation' not in last_flow['remark'], f"remark不应含Conversation: {last_flow['remark']}"


# ── TEST 5: 太短标题拒绝
def test_short_title_rejected():
    cmd_create('JJC-TEST-E2E-05', '好的', 'Zhongshu', '中书省', '中书令')
    assert _get_task('JJC-TEST-E2E-05') is None, "短标题应被拒绝"


# ── TEST 6: 传旨前缀剥离
def test_prefix_stripped():
    cmd_create('JJC-TEST-E2E-06', '传旨：帮我写技术博客文章关于智能体架构', 'Zhongshu', '中书省', '中书令')
    t = _get_task('JJC-TEST-E2E-06')
    assert t is not None, "任务应被创建"
    assert not t['title'].startswith('传旨'), f"前缀应被剥离: {t['title']}"


# ── TEST 7: state 更新 + org 自动联动
def test_state_update():
    cmd_create('JJC-TEST-E2E-07', '测试状态更新与组织联动功能', 'Zhongshu', '中书省', '中书令')
    cmd_state('JJC-TEST-E2E-07', 'Menxia', '方案提交门下省审议')
    t = _get_task('JJC-TEST-E2E-07')
    assert t is not None
    assert t['state'] == 'Menxia', f"state应为Menxia: {t['state']}"
    assert t['org'] == '门下省', f"org应为门下省: {t['org']}"


# ── TEST 8: 执行完成须提交尚书省审查，不能跳过审查直接完结
def test_done():
    cmd_create('JJC-TEST-E2E-08', '测试任务完成状态标记功能', 'Doing', '工部', '工部尚书')
    cmd_done('JJC-TEST-E2E-08', '/tmp/output.md', '任务已完成')
    t = _get_task('JJC-TEST-E2E-08')
    assert t is not None
    assert t['state'] == 'Review', f"执行完成应提交审查: {t['state']}"
    assert t['output'] == '/tmp/output.md'


def test_done_rejects_skipping_execution():
    cmd_create('JJC-TEST-E2E-10', '测试中书省不可直接完结', 'Zhongshu', '中书省', '中书令')
    cmd_done('JJC-TEST-E2E-10', '/tmp/output.md', '试图跳过执行审查')
    assert _get_task('JJC-TEST-E2E-10')['state'] == 'Zhongshu'


# ── TEST 9: 已完成任务不可覆盖
def test_done_not_overwritable():
    cmd_create('JJC-TEST-E2E-09', '测试已完成任务不可覆盖保护', 'Done', '尚书省', '尚书令')
    cmd_create('JJC-TEST-E2E-09', '试图覆盖已完成的任务标题', 'Zhongshu', '中书省', '中书令')
    t = _get_task('JJC-TEST-E2E-09')
    assert t is not None
    assert t['state'] == 'Done', f"仍应为Done: {t['state']}"
    assert t['title'] == '测试已完成任务不可覆盖保护'


# ── 支持直接运行 python3 tests/test_e2e_kanban.py
if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
