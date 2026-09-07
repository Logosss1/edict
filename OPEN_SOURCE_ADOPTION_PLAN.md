# Edict_InnerCourt 开源项目借鉴与落地计划

本文件记录本轮已经落地、当前继续落地和后续按需借鉴的开源项目能力。借鉴只服务于桌面多 Agent 工作站的可用性，不改变 EDICT 的核心协同链：

`皇上 → 太子（分拣）→ 中书省（规划）→ 门下省（审议）→ 尚书省（派发）→ 六部六个固定 Agent（执行）→ 回奏`

## 参考范围与原则

本轮只参考这些项目公开的产品结构、工程组织和交互原则，不复制品牌、页面文案、源码或 Agent 编排：

| 项目 | 官方仓库 | 参考重点 | 在本项目中的边界 |
| --- | --- | --- | --- |
| [OpenHands](https://github.com/OpenHands/OpenHands) | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 工作区边界、执行过程可见性、后端/执行环境抽象 | 工作区仍由 Edict_InnerCourt 管理；任务仍必须走 EDICT 三省六部链 |
| [LobeHub](https://github.com/lobehub/lobehub) | [lobehub/lobehub](https://github.com/lobehub/lobehub) | 工作台信息架构、Agent 运营视角、运行/历史/设置分层 | 不引入 LobeHub 的 Agent 网络或替代御书房；只借鉴桌面壳层组织方式 |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | [shadcn/ui](https://github.com/shadcn-ui/ui) | 可组合组件、设计 token、开放源码而非黑盒主题 | 采用本地 CSS token 和小型组件契约，不增加整套 UI 运行时依赖 |
| [Radix Primitives](https://github.com/radix-ui/primitives) | [radix-ui/primitives](https://github.com/radix-ui/primitives) | 可访问性、确认操作、焦点和状态反馈 | 保留现有 React 实现，逐步吸收交互规范，不把桌面端强行改成 Radix 组件树 |
| [Ant Design](https://github.com/ant-design/ant-design) | [ant-design/ant-design](https://github.com/ant-design/ant-design) | 运维型密集信息、筛选、状态色、动作反馈和文档组织 | 保留宫廷控制台视觉和原有卡片，不引入 antd 全量主题或改变核心术语 |

开源参考的验收标准不是“看起来像参考项目”，而是用户能在工作区内完成任务、看懂当前阶段、采取真实措施，并且原有审批与回奏边界仍然成立。

`upstream/` 只是当前仓库内承载 EDICT 核心的目录名，不是 fork 项目必须保留的目录，也不是 Git 的 `upstream` remote。当前保留它是为了避免在不必要的目录迁移中破坏桌面打包、运行时路径和测试；若未来改名，应单独完成路径迁移和全量验证。

## 本轮优先落地

| 项目 | 借鉴方向 | 本轮落地 | 预期结果 |
| --- | --- | --- | --- |
| OpenHands | 工作区边界、执行过程可见性、工具调用后的产出回报 | 执行保障统一体检；任务操作等待真实状态落盘；任务详情展示调度状态、最近事件、执行部门与六部目标；工作区继续作为任务的唯一项目边界 | 用户能知道任务是否真正启动、当前卡在哪里、调用了哪个固定 Agent，以及产出属于哪个项目 |
| LobeHub | 工作台信息架构、工作区/运行/历史/设置分层 | 全局应用导航移到左侧第一列；“运行、执行保障、档案、Skills & MCP、执行监控、设置”成为应用级入口；御书房只保留为工作流内的实时问询页面 | 页面不再把应用配置入口和御书房工作页面混在同一行，用户可以从同一个壳层进入不同工作区能力 |
| shadcn/ui | 可组合、可维护的界面基础结构和设计 token | 保留现有深色宫廷控制台视觉，统一使用 CSS token、可组合的导航项、任务卡、状态标签、确认框和异步反馈，不引入整套重量级主题 | 后续新增页面可以复用同一套状态、间距、焦点和响应式规则，减少“按钮能显示但没有真实动作”的问题 |
| Radix Primitives | 交互可访问性与受保护操作 | 确认框保留“返回/确认”双路径，操作期间锁定重复提交并显示等待状态；任务卡和详情弹层使用明确的按钮语义、状态播报和焦点区域 | 叫停、取消、恢复、删除等高风险动作有可撤回的确认路径，用户能看到动作正在执行而不是误以为按钮失效 |
| Ant Design | 运维型密集信息、筛选、状态和动作反馈 | 保留任务看板的紧凑卡片、活跃/归档/全部筛选、状态色和操作区；补充六部固定 Agent 体检与“等待尚书省指定六部”的非错误状态 | 多任务场景下可以快速筛选、定位阻塞点并采取操作，未分配部门不会伪装成红色派发失败 |

## 本轮补齐的开源化工作

以下内容是此前只写在原则里、但没有形成可追踪交付物的部分，本轮一并补齐：

1. 每个参考项目都有官方链接、借鉴范围、明确不照搬的边界和预期结果。
2. 双语 README 增加“开源参考与改造边界”，让使用者能区分上游 EDICT、桌面层改造和外部项目启发。
3. 临时 arm64 验收包目录加入 Git 忽略规则，避免把本机验收产物误带进公共源码。
4. 不增加新的 UI 框架依赖；现有 token、状态类、确认弹窗和执行详情继续作为本地可组合基础层，减少迁移风险。
5. 保留两个后续名额：只有出现插件市场/复杂权限管理、跨平台原生能力或大规模表格需求时，才选择新的直接匹配项目并补充评估。

## 当前落地证据

- 工作台和工作区边界：`upstream/edict/frontend/src/App.tsx`、`CommandCenterPanel.tsx`、`ExecutionInspector.tsx`。
- 任务与执行可见性：`upstream/dashboard/server.py`、`command_center.py`、`execution_workspace.py`。
- 状态确认与保护操作：`upstream/edict/frontend/src/components/ConfirmDialog.tsx`、`ExecutionGuardPanel.tsx`、`index.css`。
- 固定六部路由：`upstream/dashboard/command_center.py`、`upstream/scripts/kanban_update.py` 及对应 Python 回归测试。
- 开源边界与安全说明：根目录 `README.md`、`README.zh-CN.md`、`SECURITY.md`、`NOTICE.md`、`CONTRIBUTING.md`。

本轮只更新开源说明和仓库卫生规则，不生成安装包、不覆盖历史 Release、不向 GitHub 推送。

## 六部路由的产品约束

六部不是一个模糊的“执行中”节点，也不能由中书省或模型临时猜测执行人。系统固定维护以下映射：

| 部门 | Agent |
| --- | --- |
| 礼部 | `libu` |
| 户部 | `hubu` |
| 兵部 | `bingbu` |
| 刑部 | `xingbu` |
| 工部 | `gongbu` |
| 吏部 | `libu_hr` |

进入六部前必须已经解析出六部中的固定 Agent。新任务会在总控台建立时保存主责部门；旧数据若缺少 `targetDept`，系统按任务内容补出确定的主责部门和 Agent，再进入执行阶段。只有在固定 Agent 配置或模型体检失败时才阻止调用，不会让中书省再次承担执行分配，也不会把“没有明确 Agent”留到运行中才暴露。

## 后续按需记录

后续仍保留两个“遇到对应问题再借鉴”的名额。本轮不为了形式引入额外依赖；当出现明确的插件市场、复杂权限管理、跨平台原生能力或大规模数据表格需求时，再选择与问题直接匹配的项目并补充评估、范围和验收标准。

## 不借鉴的部分

- 不复制上述项目的品牌、页面文案或完整 UI。
- 不用新的 UI 框架替换 EDICT 已有的核心流程。
- 不把外部项目的 Agent 编排逻辑替换成另一套流程。
- 不让配置、反馈、档案等辅助页面改变三省六部的审批与回奏边界。

## 验收标准

1. 六部六个固定 Agent 均通过执行保障后，任务才允许进入执行阶段。
2. 未指定部门时任务停留在尚书省，页面显示等待指定，不出现“没有对应 Agent”的误导性失败。
3. 任务卡片和详情页的叫停、取消、恢复、删除及确认框返回均有真实状态变化或明确取消效果。
4. 每次异步操作都有处理中状态，并在状态确认后刷新页面。
5. 桌面端临时包通过回归测试后，再由用户统一验收；本轮不提前制作正式 Release。
