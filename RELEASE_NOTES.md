# Edict_InnerCourt 0.1.5

## 安装包

- `Edict_InnerCourt-0.1.5-arm64-mac.zip`：Apple Silicon。
- `Edict_InnerCourt-0.1.5-mac.zip`：Intel。

安装包内置 Node、Python 和 OpenClaw 运行时。新电脑解压并打开应用后，只需在设置页配置自己的供应商地址、API Key 和模型。安装包未签名、未公证，首次启动需要按 macOS 的“打开/仍要打开”提示操作。

## 本版重点

- 御书房同一时间只允许一场未结束的议事。
- 内廷密档、朝堂议事、旨意看板、奏折阁和详情页均支持删除终态记录。
- 删除议事时同步清理对应附件和临时运行目录；运行中的记录不能误删。
- 供应商配置与 Agent/模型绑定集中到设置页，API Key 与普通元数据分开保存，并使用 macOS 安全存储加密。
- 支持模型能力、思考深度、运行时依赖和安全策略检查。
- 保留附件上传、受控研究、失败回合恢复和任务看板等 EDICT 工作流。
- 默认安全模式不自动派发演示任务，避免首次启动产生真实外部调用。

## 验证结果

- Python：235 passed，1 skipped。
- Desktop/Vitest：39 passed。
- Playwright UI：15 passed。
- arm64 安装包已在隔离 userData 中启动并验证；x64 运行时已完成打包和冒烟检查。

## 发布边界

仓库与 Release 不包含个人供应商信息、API Key、本机运行数据、日志、缓存或本地凭据。用户需要在每台机器首次启动时自行配置供应商。源码构建命令见 [README.md](README.md)。
