# Edict Phase 1 Handover

Last updated: 2026-09-03

## Purpose

This document lets a new conversation continue the Edict Phase 1 desktop work without relying on prior chat context. It records the current implementation state, local build evidence, known gaps, repository risks, and the smallest recommended next steps.

## Product Scope Confirmed

- Product: Edict desktop control console.
- Platform: macOS 13 Ventura or later.
- Architectures: Apple Silicon (`arm64`) and Intel (`x64`).
- Desktop stack: Electron, React, TypeScript, Vite, Python sidecar.
- Desktop development port: `127.0.0.1:1517` only.
- Sidecar transport: stdin/stdout JSONL only; it must not listen on HTTP, TCP, or other network ports.
- Phase 1 exclusions: application signing, notarization, auto-update, release publishing, embedded Python runtime, remote deployment, desktop database, and automatic tool installation.

## Repository and Git Baseline

- Repository root: `/Users/happy/Documents/crow5/edict`
- Branch: `main`
- Baseline commit: `14a207557719c046af0f993a7bff1cc5a5015b33`
- Remote: `origin` points to the existing GitHub repository. Do not push unless the user explicitly asks.
- No commit, push, release, or remote configuration change has been made during the desktop implementation or build review.

Current tracked modifications:

```text
.github/workflows/ci.yml
.gitignore
README.md
edict/frontend/src/App.tsx
edict/frontend/src/index.css
```

Current untracked source and documentation areas:

```text
database/
doc/
project/
prototype/
utils/
```

Important: do not use `git add .` blindly. The existing Web frontend edits under `edict/frontend/` and the new desktop implementation under `project/` should be reviewed and staged deliberately.

## Required Project Layout

The following required directories exist:

```text
doc/                 Project documentation
prototype/           Product prototype and design artifacts
project/frontend/    Electron + React desktop application
project/backend/     Python sidecar
database/            Future database scripts; unused by desktop Phase 1
utils/               Future reusable project utilities
```

The legacy application remains in parallel and must not be confused with the new desktop Phase 1 application:

```text
dashboard/           Existing local HTTP dashboard, normally port 7891
edict/frontend/      Existing React Web dashboard
edict/backend/       Existing FastAPI, PostgreSQL, Redis, Alembic, workers
project/frontend/    New Electron desktop application
project/backend/     New Python JSONL sidecar
```

## Desktop Architecture

```text
React renderer
  -> Electron preload contextBridge
  -> Electron IPC
  -> Electron main process
  -> child_process stdin/stdout JSONL
  -> Python sidecar
```

Key files:

```text
project/frontend/electron/main.ts
project/frontend/electron/preload.ts
project/frontend/src/App.tsx
project/frontend/src/styles.css
project/frontend/package.json
project/backend/sidecar/main.py
project/backend/sidecar/service.py
project/backend/sidecar/protocol.py
project/backend/tests/test_sidecar_protocol.py
```

Security boundaries currently implemented:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- The renderer uses only `window.edictDesktop` from `preload.ts`.
- The sidecar does not import or create a network listener.

## JSONL Protocol

Protocol version: `1.0`

Supported requests:

```json
{"requestId":"health-1","command":"health"}
{"requestId":"status-1","command":"status"}
{"requestId":"task-1","command":"task.submit","payload":{"title":"Prepare the alpha release"}}
```

Supported events:

- `status`
- `task.created`

Current sidecar behavior:

- `health` returns service, protocol, and `stdio-jsonl` transport details.
- `status` returns in-memory task state and also emits a `status` event.
- `task.submit` validates a non-empty title, creates an in-memory queued task, emits `task.created`, then emits `status`.
- Invalid JSON returns `invalid_json` without terminating the process.
- Unsupported commands return `unsupported_command`.
- Tasks are not persisted and are lost when the sidecar restarts.

## Current User Interface State

### New desktop app

`project/frontend/src/App.tsx` implements a compact desktop Alpha console with:

- Sidecar health and status display.
- Manual status refresh.
- Task title input and submit action.
- Status stream task list.
- Error feedback from failed sidecar calls.

The desktop stylesheet at `project/frontend/src/styles.css` is currently a dark blue Alpha visual treatment. It is functional but does not yet match the warmer product-grade visual direction used by the existing Web dashboard refresh.

### Existing Web dashboard refresh

`edict/frontend/src/App.tsx` and `edict/frontend/src/index.css` contain uncommitted work that refreshes the existing Web dashboard toward a warm-white and graphite workspace. It includes a sidebar, command menu, task composer, responsive behavior, and visual polish.

Important functional gap: the new Web composer currently clears the local form, switches to the edicts tab, and shows a toast. It does not call the real task creation API. Do not describe this interaction as a completed task creation feature until it is connected to the existing backend flow and verified.

## Desktop Build Configuration

File: `project/frontend/package.json`

```text
Application name: Edict
Application ID: io.edict.desktop
Application version: 0.1.0
Minimum macOS version: 13.0
Architectures: arm64 and x64
Packager: electron-builder 25.1.8
Electron: 33.4.11 installed locally
```

Relevant scripts:

```bash
cd project/frontend

npm ci
npm run dev
npm run typecheck
npm run test
npm run build
npm run verify
python3 -m unittest discover -s ../backend/tests -v
npm run package:mac
npm run dist:mac
```

Script intent:

- `npm run verify`: typecheck, Vitest, and production build.
- `npm run package:mac`: unsigned `.app` directory for local smoke checks.
- `npm run dist:mac`: unsigned arm64 and x64 DMG files under `release/`.

## Build Evidence

The local macOS build completed successfully without source or configuration changes.

Verified commands:

```bash
cd project/frontend
npm run verify
npm run dist:mac

hdiutil verify release/Edict-0.1.0-arm64.dmg
hdiutil verify release/Edict-0.1.0.dmg
```

Results:

```text
npm run verify: passed
  - TypeScript typecheck: passed
  - Vitest: 1 file, 1 test passed
  - Vite production build: passed

Python sidecar unittest: passed, 3/3
DMG integrity: arm64 and x64 passed hdiutil verify
```

Generated DMG files:

| Architecture | File | Size | SHA-256 |
| --- | --- | ---: | --- |
| arm64 | `project/frontend/release/Edict-0.1.0-arm64.dmg` | 112,016,739 bytes | `1eb7547c28f471367078385f4f6b1ed37d4e1581848c4f8c047b617439ac4eb6` |
| x64 | `project/frontend/release/Edict-0.1.0.dmg` | 116,617,350 bytes | `658cd375741687f0fac380bbd72a55ba7b04720d380ca20b2f7045534b9d5ec3` |

Generated application bundles:

```text
project/frontend/release/mac-arm64/Edict.app
project/frontend/release/mac/Edict.app
```

All build outputs are intentionally ignored by Git.

## Local Environment Used for Verification

```text
Node.js: v24.19.0
npm: 11.17.0
Python: 3.13.15
Host architecture: arm64
Host macOS: 26.4.1
```

Target baseline remains Node 20+ and Python 3.12. Python 3.12 was not present on the verification machine. The standard-library sidecar passed tests on Python 3.13, but that does not replace target-device verification with Python 3.12.

## Known Risks and Blockers

### Runtime and product blockers

1. Python is not embedded in the DMG.
   - The package copies Python sidecar source only.
   - `project/frontend/electron/main.ts` defaults to `python3.12` unless `EDICT_PYTHON` is set.
   - A target Mac without a compatible Python interpreter may open the app but fail to start the sidecar.
   - Decide between a documented Python 3.12 prerequisite with clear detection/error UI, or packaging an embedded runtime/native sidecar.

2. The desktop sidecar is an in-memory proof of flow, not an integration with the existing Edict backend.
   - It has no persistence, authentication, database, orchestration, or existing task schema mapping.
   - Before expanding functionality, explicitly decide whether the desktop app should adapt the existing FastAPI system or grow an independent local sidecar domain.

3. Electron startup lifecycle needs real end-to-end verification.
   - The renderer requests `health` and `status` immediately on mount.
   - The main process currently creates the window, then starts the sidecar and registers IPC handling.
   - A cold-start race, sidecar availability error, or IPC ordering problem must be verified with a real running Electron window and then covered by an integration test.

4. The desktop frontend test suite is only a baseline test.
   - `project/frontend/src/App.test.tsx` currently asserts only the fixed development port range.
   - Add UI/IPC coverage for initial refresh, status events, successful submission, empty input, sidecar errors, and recovery.

### Distribution blockers

1. The application has no Developer ID Application signature.
2. The application has not been notarized.
3. The package uses the default Electron icon; no custom `.icns` is configured.
4. The x64 artifact was built and verified as a DMG, but not manually launched on an Intel Mac.
5. `npm audit` did not complete within the local timeout during the previous review; do not claim a clean dependency audit without rerunning it.

Consequences:

- DMG files are acceptable only as explicitly labeled unsigned Alpha/test builds.
- Do not represent them as production-ready public releases.

## Git and GitHub Upload Readiness

### Must fix before uploading the desktop source

1. Fix `.gitignore` so `project/backend/sidecar/__init__.py` is not ignored.
   - Current rule: `_*.py`
   - This matches `__init__.py`.
   - Recommended minimal change if the rule is intended only for root temporary scripts:

   ```gitignore
   /_*.py
   ```

   - Verify after the change:

   ```bash
   git check-ignore -v project/backend/sidecar/__init__.py
   ```

   The command should print nothing.

2. Deliberately add the untracked desktop source, tests, package lock, and documentation.
   - Required desktop paths include `project/frontend/**`, `project/backend/**`, and `project/README.md`.
   - Do not add ignored build outputs: `node_modules/`, `dist-*`, `release/`, `.app`, `.dmg`, `.blockmap`, or Python caches.

3. Unify documentation.
   - `README.md` has a basic desktop section but only explains `npm run build`.
   - `README_EN.md` and `README_JA.md` do not document the desktop application.
   - `CONTRIBUTING.md` does not describe desktop development, tests, or packaging.
   - Document `npm ci`, `npm run verify`, `npm run dist:mac`, architecture-specific artifacts, unsigned/notarization limits, and Python 3.12 dependency.

4. Expand CI for actual release artifacts.
   - Existing `desktop-quality` in `.github/workflows/ci.yml` runs `npm run package:mac`, which creates only an `.app` directory.
   - Add a separate controlled release workflow later for `npm run dist:mac`, artifact upload, SHA-256 output, architecture verification, signing, notarization, and tag/version checks.

5. Add a release history document such as `CHANGELOG.md` before the first public release.

### Recommended repository improvements

1. Add `/project/frontend` to `.github/dependabot.yml` because the desktop `package.json` and lockfile are nested there.
2. Add explicit `/project/frontend/` and `/project/backend/` rules to `.github/CODEOWNERS`.
3. Change generic `.env` protection to safely ignore local variants while keeping examples trackable:

   ```gitignore
   .env
   .env.*
   !.env.example
   !.env.*.example
   ```

   Review `edict/frontend/.env.development` separately before applying a blanket rule because it currently contains only a public local API URL.

4. Add secret scanning such as Gitleaks and dependency audit checks to CI.
5. Generate `SHA256SUMS.txt` and publish release notes with future DMG assets.
6. Consider Git LFS or external hosting for `docs/Agent_video_Pippit_20260225121727.mp4` (about 38 MB). It is below GitHub's 100 MB hard limit but increases clone size.

### Sensitive information review

No recognizable real private key, GitHub token, cloud key, or API key was found during the prior static scan.

Known development/placeholder values include:

```text
edict_dev_2024
change-me-in-production
```

Relevant files:

```text
edict/.env.example
edict/docker-compose.yml
.github/workflows/ci.yml
```

These are development values, not verified production credentials. They must not be reused for real deployments. GitHub Actions references to `secrets.*` are normal secure references and do not expose secret values.

## Recommended Next Conversation Prompt

Use this prompt in the next conversation:

```text
Continue Edict Phase 1 from doc/EDICT_PHASE1_HANDOVER.md. Do not commit, push, or upload anything unless I explicitly request it. First inspect the current Git status and read the handover. Prioritize fixing the .gitignore rule that hides project/backend/sidecar/__init__.py, then make the desktop source reproducibly trackable. After that, implement the smallest safe improvements for Python runtime detection and Electron-to-sidecar startup readiness, with unit tests, JSONL interface tests, and a real Electron/browser verification if the local tooling is available. Preserve existing project structure and do not refactor unrelated legacy Web code.
```

## Reproducible Validation Checklist

Run from repository root unless a command changes directory.

```bash
# Inspect changes and whitespace errors.
git status --short
git diff --check

# Verify the package initializer is not accidentally ignored after fixing .gitignore.
git check-ignore -v project/backend/sidecar/__init__.py

# Install desktop dependencies from the lockfile and verify the implementation.
cd project/frontend
npm ci
npm run verify
python3.12 -m unittest discover -s ../backend/tests -v

# Build unsigned local macOS artifacts.
npm run package:mac
npm run dist:mac

# Verify DMG integrity and record checksums.
hdiutil verify release/Edict-0.1.0-arm64.dmg
hdiutil verify release/Edict-0.1.0.dmg
shasum -a 256 release/Edict-0.1.0-arm64.dmg release/Edict-0.1.0.dmg

# Run dependency review. These may need network access and can take time.
npm audit --omit=dev
npm audit --audit-level=high

# Optional secret scan when gitleaks is installed.
cd ../..
gitleaks detect --source . --no-git --redact
```

## Explicit Non-Goals for the Immediate Next Step

- Do not upload to GitHub.
- Do not create commits unless explicitly requested.
- Do not force-reset, discard, or overwrite existing user changes.
- Do not auto-install third-party tools or Python runtimes without explicit user approval.
- Do not add signing credentials, certificates, or secrets to the repository.
- Do not refactor legacy Web dashboard or backend architecture while stabilizing the desktop Phase 1 baseline.
