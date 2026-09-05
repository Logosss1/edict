# Edict_InnerCourt

English | [中文](README.zh-CN.md)

Edict_InnerCourt is the desktop adaptation of EDICT: it preserves the Three Departments and Six Ministries multi-agent workflow while adding a distributable macOS application, a first-run setup wizard, an independent runtime bundle, and clearer boundaries for Inner Court discussions and record management.

If you only want to use it on a new computer, download the ZIP for your chip from GitHub Releases, extract it, and open `Edict_InnerCourt.app`. On first launch, open **Settings** and enter your own provider endpoint, API key, and model.

## Based on EDICT's core model

Original upstream project: [cft0808/edict](https://github.com/cft0808/edict)

The project keeps EDICT's original organization: the user issues a decree, the Crown Prince triages it, the Secretariat drafts a plan, the Chancellery reviews it, the Department of State Affairs dispatches it, and the Six Ministries execute and report back. The desktop edition brings this workflow into one local application and centralizes provider setup, Inner Court discussions, and runtime safety.

## What changed

### 1. From a source project to a distributable macOS app

- Provides separate Apple Silicon arm64 and Intel x64 packages.
- Bundles reproducible Node.js, Python, and OpenClaw runtimes, so a new computer does not need to install these dependencies first.
- Uses the application's own data directory on first launch and does not read personal runtime data from the repository.
- Safe mode does not automatically send demo tasks to agents. Enable execution only after configuration has been checked.

### 2. Provider and model setup in Settings

- Supports provider endpoints compatible with the OpenAI API shape, model discovery, custom model definitions, and per-agent model binding.
- Supports a global default model, per-agent models, thinking depth, and runtime dependency checks.
- Accepts the API key only when saving; secrets are stored separately from ordinary provider metadata and protected by macOS secure storage.
- Personal provider details and API keys are not included in the source, demo data, build output, or GitHub Releases.

### 3. A strict single-room Inner Court

- Only one unfinished Inner Court discussion can exist at a time.
- An active discussion prevents another one from being created, avoiding competing contexts and shared runtime resources.
- Agent suggestions do not automatically become tasks. The user must approve the proposal and explicitly confirm task creation through the existing task API.
- After a discussion ends, its Inner Court archive can be deleted together with its attachments and temporary runtime directory.
- New rooms attach to each Agent's canonical `agent:<agentId>:main` session, so the same Agent keeps one working memory across the task board and Inner Court.
- Inner Court can read a live, read-only progress snapshot and summon an Agent for a current-task report without creating a second task or changing the original work.

### 4. Deletion for major history records

- Inner Court archives: delete finished Inner Court discussions.
- Court Discussions: delete finished multi-agent discussion records; active records cannot be removed accidentally.
- Task Board: delete completed or cancelled tasks; running tasks must finish first.
- Memorials, task details, and session details: provide a consistent delete action for terminal records.
- Every delete action asks for confirmation. Active tasks, sessions, and discussions remain protected.

### 5. Attachment, error, and runtime safety

- Inner Court, Court Discussions, and ordinary sessions share file selection, drag-and-drop, paste, upload retry, and history download support.
- Attachments are isolated by room, with per-file, per-message, and per-room size limits.
- During a discussion, command execution, arbitrary file writes, cross-agent dispatch, and unapproved task creation are blocked.
- Failed turns preserve successful replies, pause unfinished queues, and surface the actual runtime error.

## End-to-end workflow

```text
Download a Release
        ↓
First launch in safe mode
        ↓
Settings: provider endpoint + API key + model
        ↓
Check model capabilities and bind agents
        ↓
Issue a decree
        ↓
Crown Prince triage → Secretariat plan → Chancellery review → State Affairs dispatch
        ↓
Six Ministries execute → Board tracking → Agent reports back
        ↓
Review results, retry/pause/cancel, or clean up finished history
```

### Inner Court workflow

1. Open **Inner Court**, create the single available discussion, and invite the agents needed for the topic.
2. Enter a question or attach files. Each turn is processed serially; a later message cannot open a second concurrent room.
3. Review each agent's opinion, thinking depth, and research result. Research is limited to controlled resource and document reading.
4. Use the live work panel to see what each Agent is doing and ask for a current-task report when needed. This is read-only and shares the Agent's canonical working memory.
5. Select a proposal, approve it, and confirm whether it should become a task.
6. The new task returns to the standard EDICT flow and starts with Crown Prince triage. The discussion itself can then be ended, archived, or deleted.

### Record cleanup policy

```text
Active: keep the record; allow pause, resume, or end
Finished: show a delete action and remove the record plus its dedicated attachments/runtime data
```

## New computer setup

Download from [Releases](https://github.com/Logosss1/Edict_InnerCourt/releases/latest):

- `Edict_InnerCourt-0.2.0-arm64-mac.zip`: Apple Silicon Macs (M-series).
- `Edict_InnerCourt-0.2.0-mac.zip`: Intel Macs.

Extract the ZIP, open `Edict_InnerCourt.app`, and go to **Settings**:

1. Enter your provider Base URL.
2. Enter your API key. It is stored in the local secure store and is not written into the GitHub project.
3. Add or discover models, then choose a model for each agent.
4. Check runtime readiness and enable automatic execution only when needed.

The current Release is not signed or notarized with an Apple Developer certificate. If macOS blocks it on first launch, Control-click the app and choose **Open**, then follow the system prompt after verifying the Release source.

## Local development and packaging

Source builds require Node/npm and Python. From the `desktop` directory:

```bash
npm ci
npm run verify
npm run build
npm run dist:mac
```

`npm run dist:mac` creates arm64 and x64 ZIP packages. Portable runtimes, caches, application output, test results, machine runtime data, and local credentials are ignored by Git. Release ZIPs are uploaded as GitHub Release assets rather than committed to source history.

## Project layout

```text
Edict_InnerCourt/
├── desktop/                    # Electron main process, Settings, runtime wrapper, and packaging
├── upstream/dashboard/         # EDICT board, task API, Inner Court, and Court Discussion services
├── upstream/edict/frontend/    # Board React frontend
├── upstream/agents/            # Three Departments and Six Ministries agent roles and rules
├── upstream/docker/demo_data/  # Demo data without personal configuration
├── README.md                   # English default README
└── README.zh-CN.md             # Chinese README
```

## Security boundary

- Releases contain only generic demo data. Each new computer must configure its own provider in Settings.
- Unsigned packages should be downloaded only from a Release source you have verified.

## License

Upstream code and license files remain subject to their original licenses. Contributions must comply with the upstream project's license and contribution requirements.
