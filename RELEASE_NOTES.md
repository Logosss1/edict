# Edict_InnerCourt 0.2.0

## 安装包

- `Edict_InnerCourt-0.2.0-arm64-mac.zip`：Apple Silicon。
- `Edict_InnerCourt-0.2.0-mac.zip`：Intel。

安装包内置 Node、Python 和 OpenClaw 运行时。新电脑解压并打开应用后，只需在设置页配置自己的供应商地址、API Key 和模型。安装包未签名、未公证，首次启动需要按 macOS 的“打开/仍要打开”提示操作。

## 本版重点

- 御书房同一时间只允许一场未结束的议事。
- 新开的御书房绑定 Agent 的规范主会话 `agent:<agentId>:main`，同一个 Agent 在任务看板和御书房之间共享工作记忆。
- 御书房新增实时工作状态面板，可读取当前任务、最近活动、来源任务和阻塞信息。
- 支持只读“询问进度”：正在执行的 Agent 会排队，重复点击会合并为同一请求，不会创建新任务或修改原任务。
- 增加首次配置就绪检查：运行依赖、供应商、密钥、模型目录和 Agent 绑定状态会明确显示下一步。
- 修复取消竞态：只有真正创建运行进程后才标记为当前回奏，避免取消时出现无法停止的假运行状态。
- 内廷密档、朝堂议事、旨意看板、奏折阁和详情页均支持删除终态记录。
- 共享御书房运行时不会清理 Agent 原工作区的 Skills；命令执行、文件写入和任务派发仍在议事期间禁用。

## 验证结果

- Python：240 passed，1 skipped。
- Desktop/Vitest：39 passed。
- Playwright UI：16 passed。
- 源码 Electron 版本已在隔离 userData 中启动并通过冒烟测试；随后生成 arm64/x64 Release ZIP。

## 发布边界

仓库与 Release 不包含个人供应商信息、API Key、本机运行数据、日志、缓存或本地凭据。用户需要在每台机器首次启动时自行配置供应商。源码构建命令见 [README.md](README.md)。
