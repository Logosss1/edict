# Edict_InnerCourt Release Notes

Release descriptions are maintained in English on the [GitHub Releases page](https://github.com/Logosss1/Edict_InnerCourt/releases). Each version keeps its own installation packages; later releases do not overwrite earlier ones.

## 0.2.1

- Move core OpenClaw setup into the desktop app: bundled runtime, Agent/workspace defaults, shared-session visibility, and first-run data initialization.
- Add in-app Dispatch Channel configuration for Feishu, Telegram, Discord, Slack, and Signal.
- Install supported channel plugins on first save; support named accounts, connection probing, removal, reload, and secure local credential storage.
- Preserve the single active Inner Court, shared Agent memory, terminal-record deletion, attachment isolation, and runtime diagnostics.
- Keep provider credentials and personal configuration out of source files, packaged assets, and Release artifacts.

## 0.2.0

- Enforce a single unfinished Inner Court discussion at a time.
- Reuse each Agent's canonical main session so task-board work and Inner Court conversations share working memory.
- Add live work status and read-only progress requests for running Agents.
- Add first-run readiness checks for runtime dependencies, provider credentials, model discovery, and Agent bindings.
- Add deletion controls for terminal records across Inner Court, Court Discussions, tasks, memorials, sessions, and detail pages.
- Improve cancellation handling, failure recovery, attachment cleanup, and shared-session safety.

## 0.1.5

- Publish the first complete desktop distribution with bundled Node.js, Python, and OpenClaw runtimes.
- Add in-app provider, API key, model, Agent binding, runtime, and security checks.
- Add the single-room Inner Court boundary, terminal-record deletion, attachment cleanup, capability checks, and safe first-launch behavior.

## 0.1.0–0.1.4

- Preserve the historical macOS desktop packages from the initial 0.1.x development line.
- Provide Apple Silicon and Intel ZIP packages and the early desktop setup workflow.

For the full product explanation, architecture, setup guide, troubleshooting, and security boundary, see [README.md](README.md) or [README.zh-CN.md](README.zh-CN.md).
