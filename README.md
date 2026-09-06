# Edict_InnerCourt

English | [中文](README.zh-CN.md)

<p align="center">
  <strong>A desktop distribution of EDICT's Three Departments and Six Ministries multi-agent workflow.</strong><br>
  <sub>The orchestration core stays the same; the desktop edition packages the runtime, configuration, Inner Court, and record management into a safer macOS user experience.</sub>
</p>

<p align="center">
  <a href="https://github.com/Logosss1/Edict_InnerCourt/releases/latest"><img src="https://img.shields.io/github/v/release/Logosss1/Edict_InnerCourt?display_name=tag&label=latest%20release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-macOS-111827" alt="macOS">
  <img src="https://img.shields.io/badge/Electron-desktop-47848F?logo=electron&logoColor=white" alt="Electron desktop">
  <img src="https://img.shields.io/badge/OpenClaw-bundled-2563EB" alt="OpenClaw bundled">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22C55E" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://github.com/Logosss1/Edict_InnerCourt/releases/latest">Download the latest macOS release</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="NOTICE.md">Attribution</a>
</p>

## What this project is

Edict_InnerCourt is the macOS desktop adaptation of [EDICT](https://github.com/cft0808/edict). It keeps the original Three Departments and Six Ministries model as the product's core: the user issues a decree, the Crown Prince triages it, the Secretariat plans, the Chancellery reviews, the Department of State Affairs dispatches, and the Ministries execute and report back.

This is a packaging and workflow project, not a replacement for that institutional design. The main additions are the parts needed to make the system practical on a new Mac:

- a distributable Electron application with bundled Node.js, Python, and OpenClaw runtimes;
- first-run provider, model, Agent, runtime, and dispatch-channel configuration inside the app;
- a persistent, single-room Inner Court that can inspect the live work of existing Agents;
- safer deletion and cleanup for finished records and their attachments;
- isolated local data, secure credential storage, diagnostics, and release documentation.

## What stays the same

The following are intentionally preserved from EDICT rather than redesigned away:

- the Three Departments and Six Ministries division of responsibility;
- Crown Prince triage, Secretariat planning, Chancellery review, State Affairs dispatch, and Ministry execution;
- approval gates before proposals become executable tasks;
- Agent roles, workspaces, Skills, audit-oriented records, and the task-board workflow;
- the principle that orchestration should be observable, reviewable, and interruptible.

The desktop layer changes how the system is installed and operated. It does not remove the original governance model.

## What changed from the upstream project

| Area | Original EDICT | Edict_InnerCourt |
| --- | --- | --- |
| Distribution | Clone the repository and prepare OpenClaw, Python, and Node.js on the machine. | Download a macOS ZIP with the runtime bundle included. |
| First setup | Use shell scripts and OpenClaw commands to create workspaces, register Agents, sync data, and restart services. | Use the in-app readiness checks and Settings flow; the app creates its isolated runtime data on first launch. |
| Provider and model setup | Configure OpenClaw credentials and model files as part of the local environment. | Configure provider endpoints, credentials, model discovery, Agent bindings, and thinking depth in Settings. |
| Dispatch channels | Configure OpenClaw channel plugins and account fields outside the desktop UI. | Configure supported Feishu, Telegram, Discord, Slack, and Signal accounts in **Dispatch Channel**. |
| Inner Court | Repository/dashboard workflow without a packaged macOS boundary for one shared live room. | One unfinished discussion at a time; new rooms reuse each Agent's canonical main session and can ask for read-only live progress. |
| History management | The desktop edition adds consistent deletion controls. | Finished Inner Court, Court Discussion, task, memorial, session, and detail records can be removed with confirmation and cleanup. |
| Runtime safety | The original project provides the orchestration logic and scripts. | Safe mode, isolated user data, secure secrets, attachment isolation, runtime diagnostics, and packaged launch behavior are added around it. |

## The core workflow

```text
                    user / external channel
                              │ decree
                              ▼
                     Crown Prince · triage
                              │
                              ▼
                    Secretariat · planning
                              │ proposal
                              ▼
                   Chancellery · review / veto
                              │ approved plan
                              ▼
                 State Affairs · dispatch / coordination
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
          Ministries        Skills          Agent workspaces
             └────────────────┼────────────────┘
                              ▼
                     reports / audit trail
```

The Chancellery is not decorative: it is the quality gate between planning and execution. A proposal must be reviewed and approved before the normal task API can receive it. Edict_InnerCourt adds the Inner Court as a controlled consultation layer; it does not bypass the original flow.

## Feature overview

| Area | What it provides |
| --- | --- |
| **Task Board** | Track decree status, department ownership, progress, retries, pause, cancellation, and final reports. |
| **Monitor** | Inspect Agent health, activity, task counts, and runtime observations. |
| **Models and Providers** | Configure OpenAI-compatible endpoints, discover or define models, bind a model per Agent, and select supported thinking depth. |
| **Dispatch Channel** | Configure named Feishu, Telegram, Discord, Slack, and Signal accounts, install the supported channel component on first save, probe the connection, remove accounts, and reload the dashboard. |
| **Inner Court** | Hold one live discussion at a time, invite selected Agents, share their canonical working memory, inspect read-only current progress, and approve proposals before task creation. |
| **Court Discussion** | Run multi-Agent topic discussions while preserving the discussion record and approval boundary. |
| **Memorials and Sessions** | Review completed work, task history, session details, and terminal records; delete finished records when they are no longer needed. |
| **Attachments** | Select, paste, drag, upload, retry, and download files with room-scoped isolation and size limits. |
| **Skills and Agent roles** | Keep the upstream Agent role and Skills model available to the packaged dashboard and runtime. |

## Desktop architecture

```text
┌─────────────────────────────────────────────────────────┐
│ Edict_InnerCourt.app                                    │
│                                                         │
│  Electron shell                                         │
│  ├─ Settings and runtime readiness                       │
│  ├─ macOS secure credential bridge                       │
│  ├─ provider/model/channel configuration                 │
│  └─ dashboard lifecycle and diagnostics                  │
│                                                         │
│  Bundled runtime                                         │
│  ├─ Node.js                                              │
│  ├─ Python                                               │
│  └─ OpenClaw + channel components                        │
│                                                         │
│  Packaged EDICT services                                 │
│  ├─ React dashboard                                      │
│  ├─ Python task, Court Discussion, and Inner Court APIs  │
│  ├─ Agent definitions and Skills                         │
│  └─ isolated per-install user data                      │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
             OpenClaw Agent main sessions and providers
```

The app keeps ordinary provider metadata separate from secrets. Provider and channel secrets are stored in the local encrypted credential store; OpenClaw configuration receives environment-backed SecretRefs rather than plaintext secret values. Release assets contain generic demo data, not the maintainer's provider configuration or user data.

## Quick start for users

### 1. Download the correct package

Open [GitHub Releases](https://github.com/Logosss1/Edict_InnerCourt/releases/latest):

- `Edict_InnerCourt-0.2.1-arm64-mac.zip` for Apple Silicon Macs (M-series);
- `Edict_InnerCourt-0.2.1-mac.zip` for Intel Macs.

Extract the ZIP and open `Edict_InnerCourt.app`.

### 2. Complete the in-app setup

In **Settings**:

1. Enter your provider Base URL and API key.
2. Discover or define the models exposed by that provider.
3. Bind a model to each Agent and review the available thinking levels.
4. Confirm that the bundled runtime and OpenClaw checks are ready.
5. If external message dispatch is needed, open **Dispatch Channel**, enter the platform-issued account details, save, test the connection, and reload the dashboard when prompted.

The platform-side work is still external: creating a Feishu app or bot, granting permissions, enabling WebSocket or Socket Mode, and copying the credentials into the app. The desktop app cannot create an account on a third-party platform for you.

### 3. Issue a decree

Once setup is ready, use the normal EDICT flow:

```text
decree → Crown Prince triage → Secretariat plan
      → Chancellery review → State Affairs dispatch
      → Ministry execution → report and audit trail
```

Safe mode is the default for a fresh install. Do not enable automatic execution until the provider, models, Agents, and dispatch settings have been checked.

## Inner Court workflow

The Inner Court is a live consultation room, not a second task system.

1. Open **Inner Court** and create the one available unfinished discussion.
2. Invite only the Agents needed for the topic.
3. Ask questions or attach files. Messages are processed serially inside the room.
4. Use the live work panel to see what an Agent is currently doing and request a read-only progress report.
5. Review the Agents' replies and proposals. Nothing becomes a task automatically.
6. Approve a proposal and explicitly confirm task creation when it should return to the normal EDICT workflow.
7. End, archive, or delete the finished discussion when it is no longer needed.

Every Agent keeps its canonical main session, so the same Agent can continue its existing work when summoned to the Inner Court. A second unfinished Inner Court room is rejected to prevent competing live contexts.

## Record and data policy

```text
Active record   → keep it; pause, resume, finish, or inspect it
Terminal record → ask for confirmation, then delete its record and dedicated runtime data
```

The app protects active tasks, sessions, and discussions from accidental deletion. Finished Inner Court archives, Court Discussions, tasks, memorials, sessions, and detail records expose deletion controls. Room-scoped attachments and temporary runtime files are cleaned with the record where applicable.

## Technical highlights

- **Packaged runtime:** Node.js, Python, and OpenClaw are shipped with the app so a new Mac does not need a separate runtime installation for normal use.
- **Isolated user data:** the application uses its own per-install data directory instead of reading personal OpenClaw state from the source tree.
- **Secure credential boundary:** provider and channel secrets are stored separately from ordinary metadata and are injected only into the child runtime that needs them.
- **OpenClaw SecretRefs:** desktop-managed channel configuration writes environment references to OpenClaw JSON, not plaintext tokens.
- **Canonical Agent memory:** Inner Court rooms attach to `agent:<agentId>:main` so consultation does not fork an Agent's working memory.
- **Single-room coordination:** one unfinished Inner Court room and a serial room queue avoid concurrent replies fighting over the same shared session.
- **Attachment isolation:** uploaded files are scoped to the room/message and cleaned safely after terminal records are deleted.
- **Failure recovery:** partial runs preserve successful replies, pause unfinished work, surface the actual error, and allow a retry without silently replaying completed work.
- **Capability-aware models:** the UI checks model capabilities and prevents unsupported thinking-depth requests from being sent blindly.
- **Safe first launch:** demo data does not automatically become a real external dispatch; the user explicitly enables execution after setup.

## Troubleshooting and FAQ

### macOS says the app cannot be opened

The current packages are not signed or notarized with an Apple Developer certificate. Verify that the ZIP came from the official [Release page](https://github.com/Logosss1/Edict_InnerCourt/releases), then Control-click the app, choose **Open**, and follow the macOS prompt.

### The app says that the runtime is not ready

Open **Settings → Runtime** and run the dependency check again. The packaged build should prefer its bundled Node.js, Python, and OpenClaw. If this is a development build, confirm that the build was started from `desktop` after preparing the portable runtime.

### The provider or model list cannot be loaded

Check the Base URL, API key, network access, and whether the endpoint exposes an OpenAI-compatible `/models` response. Save the provider again, refresh the model catalog, and bind a model to the Agent before sending a decree.

### A thinking level is unavailable

Thinking levels are capability-dependent. Choose one of the levels shown for the selected model, or run the explicit capability probe after confirming that the provider may receive a test request. Do not force a level that the provider rejected.

### The dispatch channel is saved but messages do not arrive

Run **Detect connection**, verify the third-party platform permissions, confirm WebSocket or Socket Mode settings, and use **Reload dashboard** after changing a channel secret. The app configures the supported channel account; it cannot repair permissions inside the external platform.

### Why does a second Inner Court room fail to open?

That is intentional. The desktop edition allows one unfinished Inner Court discussion at a time because all summoned Agents share their canonical working sessions. Finish or delete the current terminal room before opening another.

### I cannot delete a record

Active tasks, sessions, and discussions are protected. Finish, cancel, or otherwise move the record to a terminal state first; then use its confirmed delete action.

### Can I use this package on Windows or Linux?

The distributed application is currently macOS-only and provides arm64 and x64 macOS packages. The upstream EDICT source has separate deployment paths; this desktop packaging project does not claim cross-platform desktop installers yet.

## Development and verification

The source tree is for development and customization. End users should use the Release ZIP instead of building the project on a new Mac.

```bash
cd desktop
npm ci
npm run verify       # TypeScript checks + Electron unit tests
npm run test:ui      # Playwright dashboard tests
npm run build        # Python, frontend, and Electron build
npm run dist:mac     # arm64 + x64 macOS ZIP packages
```

The Python suite is run from the repository root:

```bash
python3 -m pytest -q
```

The packaging process writes generated applications and archives under `desktop/release/`; generated runtime data, caches, test output, local credentials, and personal provider configuration are excluded from source control.

## Project layout

```text
Edict_InnerCourt/
├── desktop/
│   ├── electron/             # Electron main process, preload, secure storage, lifecycle
│   ├── main/                 # runtime discovery and OpenClaw integration
│   ├── e2e/                  # packaged-app and dashboard smoke tests
│   ├── tests/                # TypeScript integration/unit tests
│   ├── settings/             # standalone desktop Settings window
│   └── scripts/              # portable-runtime preparation and packaging helpers
├── upstream/
│   ├── agents/               # Three Departments and Six Ministries roles and rules
│   ├── dashboard/            # task board, Inner Court, Court Discussion, and APIs
│   ├── edict/frontend/       # React dashboard frontend
│   ├── scripts/              # state machine, synchronization, and runtime helpers
│   ├── tests/                # Python service and workflow tests
│   └── docker/demo_data/     # generic first-run data only
├── LICENSE                  # MIT license for this distribution
├── NOTICE.md                # upstream attribution and packaging boundary
├── SECURITY.md              # private vulnerability reporting and security guidance
├── CONTRIBUTING.md          # development and contribution workflow
├── CODE_OF_CONDUCT.md       # community expectations
├── README.md                # default English documentation
└── README.zh-CN.md          # Chinese documentation
```

## Security, support, and attribution

- Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Do not put API keys, provider credentials, OpenClaw user data, or private logs in a public issue.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the runtime boundary or the Three Departments and Six Ministries workflow.
- The project is distributed under the [MIT License](LICENSE). Upstream EDICT attribution and license information are preserved in [NOTICE.md](NOTICE.md) and `upstream/LICENSE`.
- Share product ideas, workflow improvements, and general feedback in [GitHub Discussions](https://github.com/Logosss1/Edict_InnerCourt/discussions).
- Report reproducible bugs through [GitHub Issues](https://github.com/Logosss1/Edict_InnerCourt/issues) and include the app version, macOS version, architecture, reproduction steps, and redacted logs.
- Do not include API keys, provider credentials, OpenClaw user data, or private logs in public discussions or issues.
- For the original orchestration design, see the [upstream EDICT project](https://github.com/cft0808/edict).

## Release policy

Each version is uploaded as a separate GitHub Release; later versions do not replace earlier installation packages. The latest stable package is always available from [Releases](https://github.com/Logosss1/Edict_InnerCourt/releases), with a compact local history in [RELEASE_NOTES.md](RELEASE_NOTES.md).
