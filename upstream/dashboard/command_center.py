"""Desktop command-center primitives.

The command center is intentionally small and deterministic.  It does not
replace Taizi's model-based routing; it gives the desktop shell a cheap,
explainable preflight classification before the original EDICT chain is
invoked.  The stored conversation contains no provider credentials.
"""

from __future__ import annotations

import datetime
import pathlib
import re
import uuid
from typing import Any

from file_lock import atomic_json_read, atomic_json_update


MODES = ("chat", "small", "standard", "complex")
MODE_LABELS = {
    "chat": "实时问询",
    "small": "小任务",
    "standard": "正式任务",
    "complex": "复杂任务",
}

_QUESTION_RE = re.compile(
    r"^(?:什么|为何|为什么|怎么|如何|能否|是否|有没有|目前|现在|进展|状态|请问|告诉我|解释|查看|问一下)"
)
_COMPLEX_MARKERS = (
    "全部agent", "所有agent", "多agent", "多 Agent", "三省六部", "从规划到", "一条龙",
    "完整流程", "完整方案", "并且", "同时", "以及", "然后", "最后", "跨部门", "拆解",
    "规划并实现", "设计并开发", "代码和文档", "测试并发布", "全流程",
)
_WORK_MARKERS = (
    "写", "做", "生成", "实现", "开发", "修改", "修复", "创建", "编程", "测试", "审查",
    "分析", "规划", "整理", "导出", "保存", "运行", "报告", "文档", "代码", "文件",
    "pdf", "excel", "word", "markdown", "网页", "项目",
)
_SMALL_MARKERS = (
    "检查", "查看", "读取", "解释", "总结", "列出", "确认", "测一下", "跑一下", "简单",
    "改一处", "改一个", "查一下",
)

SIX_MINISTRY_KEYWORDS = {
    "礼部": ("文案", "文章", "博客", "翻译", "邮件", "内容", "发布", "文档", "pdf", "word"),
    "户部": ("数据", "表格", "excel", "统计", "预算", "报表", "分析", "csv"),
    "兵部": ("代码", "编程", "开发", "接口", "网页", "项目", "git", "测试", "bug"),
    "刑部": ("安全", "合规", "审计", "漏洞", "权限", "风险", "法律"),
    "工部": ("部署", "基础设施", "环境", "运行", "构建", "打包", "性能", "服务器"),
    "吏部": ("人员", "流程", "排班", "组织", "角色", "团队"),
}
SIX_MINISTRY_AGENTS = {
    "礼部": "libu",
    "户部": "hubu",
    "兵部": "bingbu",
    "刑部": "xingbu",
    "工部": "gongbu",
    "吏部": "libu_hr",
}


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip()).lower()


def infer_ministry(text: str) -> str:
    value = _normalise(text)
    scores = {
        department: sum(1 for keyword in keywords if keyword.lower() in value)
        for department, keywords in SIX_MINISTRY_KEYWORDS.items()
    }
    best = max(scores, key=scores.get)
    return best if scores[best] else "兵部"


def classify_instruction(text: str, requested_mode: str | None = None) -> str:
    """Return a cheap, explainable mode for the desktop intake.

    A user-selected mode is an explicit override, while the default keeps
    simple questions out of the formal-task queue.  This classifier is only a
    front-door hint; the Taizi Agent remains the authority for formal routing.
    """
    requested = str(requested_mode or "").strip().lower()
    if requested in MODES:
        return requested
    value = _normalise(text)
    if not value:
        return "chat"
    if _QUESTION_RE.search(value) and not any(marker in value for marker in ("写", "生成", "实现", "修改", "开发")):
        return "chat"
    if len(value) >= 180 or value.count("\n") >= 2 or sum(value.count(marker) for marker in _COMPLEX_MARKERS) >= 2:
        return "complex"
    if any(marker.lower() in value for marker in _COMPLEX_MARKERS) and len(value) >= 60:
        return "complex"
    if any(marker.lower() in value for marker in _WORK_MARKERS):
        if len(value) <= 70 and any(marker.lower() in value for marker in _SMALL_MARKERS):
            return "small"
        return "standard"
    if len(value) <= 70 and any(marker.lower() in value for marker in _SMALL_MARKERS):
        return "small"
    return "chat"


def build_plan(text: str, mode: str | None = None) -> dict[str, Any]:
    selected = classify_instruction(text, mode)
    department = infer_ministry(text)
    if selected == "chat":
        agents = ["taizi"]
        reason = "内容更像实时问询，不建立正式旨意。"
        next_step = "进入御书房向太子或指定 Agent 询问当前进展。"
    elif selected == "small":
        agents = [SIX_MINISTRY_AGENTS[department]]
        reason = f"识别为单一动作，优先交给空闲的{department} Agent。"
        next_step = f"由{department}（{SIX_MINISTRY_AGENTS[department]}）执行并直接回奏。"
    else:
        agents = ["taizi", "zhongshu", "menxia", "shangshu", *SIX_MINISTRY_AGENTS.values()]
        reason = "识别为需要留痕的正式工作，保留完整三省六部流程。"
        next_step = "皇上 → 太子 → 中书省 → 门下省 → 尚书省 → 六部 → 回奏。"
        # Persist a deterministic primary execution department up front.  The
        # formal chain still decides and records the final hand-off, but the
        # task never reaches 六部 with an empty target and burns a model call
        # trying to discover an Agent that does not exist.
        if selected == "complex":
            reason = "识别为多步骤或跨部门工作，需要先看清计划和执行边界。"
    return {
        "mode": selected,
        "modeLabel": MODE_LABELS[selected],
        "reason": reason,
        "suggestedAgents": agents,
        "targetDept": department if selected in {"small", "standard", "complex"} else "",
        "nextStep": next_step,
        "requiresApproval": selected == "complex",
        "permissionScope": "当前工作区内读写、运行项目命令和测试；工作区外及系统级敏感操作另行确认",
    }


def make_message(role: str, text: str, plan: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
    message: dict[str, Any] = {
        "id": uuid.uuid4().hex,
        "role": role,
        "text": str(text or "").strip()[:12_000],
        "at": now_iso(),
    }
    if plan:
        message["plan"] = plan
    message.update(extra)
    return message


class CommandCenterStore:
    """Small atomic JSON store scoped to one desktop data directory."""

    def __init__(self, data_dir: str | pathlib.Path):
        self.data_dir = pathlib.Path(data_dir)
        self.path = self.data_dir / "command_center.json"

    @staticmethod
    def _default() -> dict[str, Any]:
        return {"version": 1, "messages": [], "pendingPlan": None, "updatedAt": ""}

    def snapshot(self) -> dict[str, Any]:
        value = atomic_json_read(self.path, self._default())
        if not isinstance(value, dict):
            return self._default()
        messages = value.get("messages") if isinstance(value.get("messages"), list) else []
        return {
            "version": 1,
            "messages": messages[-200:],
            "pendingPlan": value.get("pendingPlan") if isinstance(value.get("pendingPlan"), dict) else None,
            "updatedAt": value.get("updatedAt") or "",
        }

    def append(self, message: dict[str, Any]) -> dict[str, Any]:
        def update(value: Any) -> dict[str, Any]:
            current = value if isinstance(value, dict) else self._default()
            messages = current.get("messages") if isinstance(current.get("messages"), list) else []
            messages.append(message)
            current["version"] = 1
            current["messages"] = messages[-200:]
            current["updatedAt"] = now_iso()
            return current

        return atomic_json_update(self.path, update, default=self._default())

    def set_pending(self, plan: dict[str, Any] | None) -> dict[str, Any]:
        def update(value: Any) -> dict[str, Any]:
            current = value if isinstance(value, dict) else self._default()
            current["pendingPlan"] = plan
            current["updatedAt"] = now_iso()
            return current

        return atomic_json_update(self.path, update, default=self._default())
