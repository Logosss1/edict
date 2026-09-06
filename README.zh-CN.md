# Edict_InnerCourt

[English](README.md) | 中文

<p align="center">
  <strong>EDICT“三省六部”多 Agent 协作流程的 macOS 桌面发行版。</strong><br>
  <sub>核心编排制度保持不变；桌面版把运行时、配置、御书房和记录管理包装成更适合日常使用的新电脑体验。</sub>
</p>

<p align="center">
  <a href="https://github.com/Logosss1/Edict_InnerCourt/releases/latest"><img src="https://img.shields.io/github/v/release/Logosss1/Edict_InnerCourt?display_name=tag&label=latest%20release" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/platform-macOS-111827" alt="macOS">
  <img src="https://img.shields.io/badge/Electron-desktop-47848F?logo=electron&logoColor=white" alt="Electron 桌面版">
  <img src="https://img.shields.io/badge/OpenClaw-bundled-2563EB" alt="内置 OpenClaw">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22C55E" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://github.com/Logosss1/Edict_InnerCourt/releases/latest">下载最新 macOS 版本</a> ·
  <a href="SECURITY.md">安全政策</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="NOTICE.md">项目归属</a>
</p>

## 项目是什么

Edict_InnerCourt 是 [EDICT](https://github.com/cft0808/edict) 的 macOS 桌面化发行版。它保留原项目“三省六部”的核心制度：用户下旨，太子分拣，中书省规划，门下省审议，尚书省派发，再由六部执行并回奏。

这不是另起炉灶重写一个 Multi-Agent 框架，而是对原有核心进行桌面化包装和使用流程完善，重点补上新电脑分发和日常操作所需要的能力：

- 提供内置 Node.js、Python、OpenClaw 的可分发 Electron 应用；
- 在软件内完成供应商、模型、Agent、运行时和派发渠道的首次配置；
- 提供持久化、同一时间只允许一场的御书房，并能查看既有 Agent 的实时工作进度；
- 为已结束的记录提供删除和附件/临时运行数据清理；
- 隔离本地数据，保护凭据，提供运行诊断和持续版本说明。

## 哪些核心没有改变

以下内容是 EDICT 的制度内核，桌面版有意保留，没有用普通聊天式 Agent 协作替代：

- 三省六部的职责分工；
- 太子分拣、中书省规划、门下省审议、尚书省派发、六部执行；
- 方案在进入执行前必须经过审核和批准；
- Agent 角色、工作区、Skills、审计导向的记录和任务看板流程；
- 协作过程应当可观察、可审议、可干预。

桌面层改变的是安装和操作方式，不改变原有的分权制衡和任务流转逻辑。

## 与原始 EDICT 的区别

| 方面 | 原始 EDICT | Edict_InnerCourt |
| --- | --- | --- |
| 分发方式 | 克隆仓库后，在电脑上准备 OpenClaw、Python、Node.js。 | 下载内置运行时的 macOS ZIP。 |
| 首次安装 | 通过 shell 脚本和 OpenClaw 命令创建工作区、注册 Agent、同步数据、重启服务。 | 通过软件内的就绪检查和设置流程完成；首次启动自动创建隔离运行数据。 |
| 供应商和模型 | 作为本地 OpenClaw 环境的一部分配置凭据和模型文件。 | 在设置页配置供应商、密钥、模型发现、Agent 绑定和思考深度。 |
| 派发渠道 | 在桌面界面之外配置 OpenClaw 渠道组件和账号字段。 | 在“派发渠道”里配置飞书、Telegram、Discord、Slack、Signal。 |
| 御书房 | 以仓库/看板流程为主，没有打包后的 macOS 单场实时议事边界。 | 同一时间只允许一场未结束议事；新房间复用 Agent 规范主会话，可只读询问实时进度。 |
| 历史管理 | 桌面版增加统一的记录删除入口。 | 御书房、朝堂议事、任务、奏折、会话和详情页的终态记录可确认删除并清理相关数据。 |
| 运行安全 | 原项目提供核心编排逻辑和脚本。 | 在外围增加安全模式、隔离数据、安全密钥、附件隔离、运行诊断和桌面启动管理。 |

## 三省六部核心工作流

```text
                       皇上 / 外部渠道
                              │ 下旨
                              ▼
                         太子 · 分拣
                              │
                              ▼
                        中书省 · 规划
                              │ 拟办方案
                              ▼
                        门下省 · 审议/封驳
                              │ 准奏方案
                              ▼
                    尚书省 · 派发/协调
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
           六部执行          Skills          Agent 工作区
             └────────────────┼────────────────┘
                              ▼
                         回奏 / 留痕
```

门下省不是装饰性的中间页面，而是规划进入执行前的质量关口。方案必须经过审议和批准，才能提交原有任务 API。御书房是受控的讨论层，不会绕过三省六部的主流程。

## 功能全景

| 功能区 | 能做什么 |
| --- | --- |
| **旨意看板** | 查看旨意状态、部门归属、进度、重试、暂停、取消和最终回奏。 |
| **省部调度** | 查看 Agent 健康度、活动、任务数量和运行观察。 |
| **模型与供应商** | 配置 OpenAI 兼容接口、发现或定义模型、按 Agent 绑定模型、选择支持的思考深度。 |
| **派发渠道** | 配置命名的飞书、Telegram、Discord、Slack、Signal 账号；首次保存时安装组件，支持检测、移除和重载。 |
| **御书房** | 同时只开一场议事，邀请指定 Agent，共享其规范主会话记忆，查看只读实时进度，审批方案后再创建任务。 |
| **朝堂议事** | 围绕议题进行多 Agent 讨论，并保留讨论记录和审批边界。 |
| **奏折阁与会话** | 查看已完成工作、任务历史、会话详情和终态记录；不再需要时确认删除。 |
| **附件能力** | 选择、粘贴、拖放、上传、重试和下载文件，并按房间隔离和限制大小。 |
| **Skills 与 Agent 角色** | 保留原项目 Agent 角色与 Skills 模型，让打包后的看板和运行时继续使用。 |

## 桌面版架构

```text
┌─────────────────────────────────────────────────────────┐
│ Edict_InnerCourt.app                                    │
│                                                         │
│  Electron 外壳                                          │
│  ├─ 设置页与运行时就绪检查                               │
│  ├─ macOS 安全凭据桥接                                   │
│  ├─ 供应商/模型/渠道配置                                 │
│  └─ 看板生命周期与诊断                                   │
│                                                         │
│  内置运行时                                              │
│  ├─ Node.js                                              │
│  ├─ Python                                               │
│  └─ OpenClaw + 渠道组件                                  │
│                                                         │
│  打包后的 EDICT 服务                                     │
│  ├─ React 看板                                           │
│  ├─ Python 任务、朝堂议事和御书房 API                    │
│  ├─ Agent 角色与 Skills                                  │
│  └─ 每个安装实例独立的本地数据                            │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
                OpenClaw Agent 主会话与供应商
```

软件会把普通供应商元数据和密钥分开处理。供应商密钥、渠道 Token/Secret 进入本机加密凭据存储；OpenClaw 配置文件只写环境变量引用，不写入明文密钥。Release 只包含通用演示数据，不包含维护者的供应商配置或本机运行数据。

## 新电脑快速开始

### 1. 下载对应架构

打开 [GitHub Releases](https://github.com/Logosss1/Edict_InnerCourt/releases/latest)：

- Apple Silicon（M 系列）下载 `Edict_InnerCourt-0.2.1-arm64-mac.zip`；
- Intel Mac 下载 `Edict_InnerCourt-0.2.1-mac.zip`。

解压后打开 `Edict_InnerCourt.app`。

### 2. 在软件内完成配置

进入“设置”：

1. 填写供应商 Base URL 和 API Key；
2. 发现或手动定义供应商提供的模型；
3. 为各 Agent 绑定模型，并检查可用思考深度；
4. 确认内置运行时和 OpenClaw 检查就绪；
5. 如需外部消息派发，进入“派发渠道”，填写平台账号信息，保存、检测连接，并按提示重载看板。

平台侧的工作仍需在外部完成：创建飞书应用或机器人、开通权限、启用 WebSocket/Socket Mode，以及复制平台生成的凭据。桌面软件无法替用户在第三方平台注册账号。

### 3. 下旨

配置就绪后，按原有 EDICT 流程使用：

```text
用户下旨 → 太子分拣 → 中书省规划
        → 门下省审议 → 尚书省派发
        → 六部执行 → 回奏与审计记录
```

新安装默认处于安全模式。确认供应商、模型、Agent 和渠道无误后，再按需要开启自动执行。

## 御书房使用流程

御书房是实时议事房，不是第二套任务系统。

1. 打开“御书房”，创建唯一一场未结束的议事；
2. 只邀请当前议题需要的 Agent；
3. 输入问题或上传附件，房间内按队列串行处理；
4. 在实时工作状态面板查看 Agent 当前在做什么，必要时只读询问进度；
5. 查看 Agent 回答和方案，方案不会自动变成任务；
6. 审批方案，并明确确认是否回到原有 EDICT 流程创建任务；
7. 议事结束后，可以归档或删除密档。

每个 Agent 继续使用自己的规范主会话，因此被召入御书房时能够接续原有工作记忆。为了避免共享上下文互相争用，同时只允许一场未结束的御书房议事。

## 记录与数据原则

```text
进行中记录 → 保留；允许暂停、恢复、结束或查看
终态记录   → 二次确认后删除记录及其专属运行数据
```

进行中的任务、会话和议事不会被误删。已结束的御书房密档、朝堂议事、旨意、奏折、会话和详情页提供删除入口；适用时同步清理房间附件和临时运行目录。

## 技术亮点

- **内置运行时：** 随软件提供 Node.js、Python、OpenClaw，普通用户在新 Mac 上无需另行安装运行时。
- **数据隔离：** 使用每个安装实例自己的数据目录，不直接读取源码目录中的个人 OpenClaw 状态。
- **密钥边界：** 供应商和渠道密钥与普通元数据分开保存，只注入需要它们的子进程运行环境。
- **OpenClaw SecretRef：** 软件管理的渠道配置在 OpenClaw JSON 中写环境引用，不写入明文 Token。
- **共享 Agent 记忆：** 御书房接入 `agent:<agentId>:main`，不会因为一次召见而复制出第二套 Agent 工作记忆。
- **单场议事与串行队列：** 避免多个房间或并发回合争用同一套共享会话。
- **附件隔离：** 上传文件按房间和消息隔离，终态记录删除时安全清理。
- **失败恢复：** 部分回合会保留已经成功的回复，暂停未完成队列并显示真实错误，重试时不静默重复已完成工作。
- **模型能力感知：** 界面根据模型能力显示思考深度，避免盲目发送供应商不支持的参数。
- **首次启动安全模式：** 演示数据不会自动变成真实外部派发，必须由用户在配置完成后明确开启执行。

## 常见问题与排查

### macOS 提示无法打开软件

当前安装包没有 Apple Developer 签名和公证。确认 ZIP 来自官方 [Release 页面](https://github.com/Logosss1/Edict_InnerCourt/releases)，然后 Control-click 应用并选择“打开”，按 macOS 提示继续。

### 软件提示运行时未就绪

进入“设置 → 运行时”重新检测。打包版应优先使用内置 Node.js、Python 和 OpenClaw。若使用源码开发版，请确认是在 `desktop` 目录准备好 portable runtime 后启动的。

### 供应商或模型列表加载失败

检查 Base URL、API Key、网络，以及接口是否提供 OpenAI 兼容的 `/models` 响应。重新保存供应商、刷新模型目录，并为 Agent 绑定模型后再下旨。

### 某个思考深度不可用

思考深度取决于模型能力。请选择界面为当前模型显示的等级；如需确认更高等级，先在明确同意发送测试请求后运行能力探测，不要强行使用供应商已拒绝的等级。

### 渠道保存成功但收不到消息

点击“检测连接”，检查第三方平台权限、WebSocket/Socket Mode 设置；修改渠道密钥后使用“立即重载看板”。软件能配置支持的渠道账号，但不能替你修复外部平台权限。

### 为什么不能再打开第二场御书房

这是有意设计的。桌面版要求同一时间只有一场未结束议事，因为被召见的 Agent 共享规范主会话。请先结束或删除当前终态议事，再新开一场。

### 为什么不能删除记录

进行中的任务、会话和议事受到保护。先完成、取消或结束记录，使其进入终态后，再使用带确认的删除入口。

### 可以在 Windows 或 Linux 上使用吗

当前发布的桌面应用只支持 macOS，提供 arm64 和 x64 两种安装包。原始 EDICT 源码有其他部署路径，但本桌面项目目前不宣称提供 Windows/Linux 桌面安装包。

## 开发与验证

源码适合开发和定制；新电脑普通用户应优先使用 Release ZIP，不需要自己构建项目。

```bash
cd desktop
npm ci
npm run verify       # TypeScript 检查 + Electron 单测
npm run test:ui      # Playwright 看板测试
npm run build        # Python、前端和 Electron 构建
npm run dist:mac     # 生成 arm64 + x64 macOS ZIP
```

Python 测试在仓库根目录执行：

```bash
python3 -m pytest -q
```

打包会在 `desktop/release/` 下生成应用和压缩包；运行时数据、缓存、测试输出、本地凭据和个人供应商配置均不应进入源码管理。

## 项目结构

```text
Edict_InnerCourt/
├── desktop/
│   ├── electron/             # Electron 主进程、preload、安全存储、生命周期
│   ├── main/                 # 运行时发现与 OpenClaw 集成
│   ├── e2e/                  # 打包版与看板冒烟测试
│   ├── tests/                # TypeScript 集成/单元测试
│   ├── settings/             # 独立桌面设置窗口
│   └── scripts/              # portable runtime 准备和打包辅助脚本
├── upstream/
│   ├── agents/               # 三省六部 Agent 角色与规则
│   ├── dashboard/            # 看板、御书房、朝堂议事与 API
│   ├── edict/frontend/       # React 看板前端
│   ├── scripts/              # 状态机、同步和运行时辅助脚本
│   ├── tests/                # Python 服务与工作流测试
│   └── docker/demo_data/     # 仅包含通用首次运行数据
├── LICENSE                  # 本发行版的 MIT 许可证
├── NOTICE.md                # 上游归属与打包边界
├── SECURITY.md              # 私密漏洞报告和安全说明
├── CONTRIBUTING.md          # 开发与贡献流程
├── CODE_OF_CONDUCT.md       # 社区行为准则
├── README.md                # 默认英文说明
└── README.zh-CN.md          # 中文说明
```

## 安全、支持与归属

- 报告漏洞前请先阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中放入 API Key、供应商凭据、OpenClaw 用户数据或未脱敏日志。
- 修改运行时边界或三省六部流程前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 项目使用 [MIT License](LICENSE)。上游 EDICT 的归属和许可证信息保留在 [NOTICE.md](NOTICE.md) 与 `upstream/LICENSE`。
- 产品想法、工作流改进和一般使用反馈，请发布到 [GitHub Discussions](https://github.com/Logosss1/Edict_InnerCourt/discussions)。
- 可复现的 Bug 请通过 [GitHub Issues](https://github.com/Logosss1/Edict_InnerCourt/issues) 报告，并提供软件版本、macOS 版本、芯片架构、复现步骤和已脱敏日志。
- 不要在公开讨论或 Issue 中放入 API Key、供应商凭据、OpenClaw 用户数据或私人日志。
- 关于三省六部原始编排设计，请参阅[上游 EDICT 项目](https://github.com/cft0808/edict)。

## Release 策略

每个版本都作为独立 GitHub Release 上传，后续版本不会覆盖之前的安装包。最新稳定版本始终位于 [Releases](https://github.com/Logosss1/Edict_InnerCourt/releases)，本地版本历史见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。
