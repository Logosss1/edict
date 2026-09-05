# Contributing to Edict_InnerCourt

Thank you for helping improve the desktop distribution of EDICT. Contributions should make the original Three Departments and Six Ministries workflow easier to use, safer to operate, or easier to understand without weakening its review and approval boundaries.

## Before opening an issue

For a bug, include:

- the app version or commit;
- macOS version and Apple Silicon/Intel architecture;
- the page and workflow involved;
- precise reproduction steps;
- expected behavior and actual behavior;
- redacted logs or screenshots when useful.

For a feature request, describe the user problem, the smallest useful workflow, and whether it changes the original EDICT orchestration model. Do not include API keys, provider credentials, private attachments, or raw OpenClaw user data.

Do not use public Issues or Discussions for security vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## Development setup

End users should use a GitHub Release. Contributors can prepare the source tree with:

```bash
cd desktop
npm ci
npm run verify
npm run test:ui
```

Run the Python suite from the repository root:

```bash
python3 -m pytest -q
```

Build and package on macOS with:

```bash
cd desktop
npm run build
npm run dist:mac
```

The build may download or prepare the bundled portable runtime. Do not commit generated applications, runtime caches, test output, user data, or local credentials.

## Where to make changes

| Area | Typical responsibility |
| --- | --- |
| `desktop/electron/` | Application lifecycle, secure storage, IPC, runtime and dashboard process management. |
| `desktop/main/` | Runtime discovery and OpenClaw integration. |
| `desktop/e2e/` and `desktop/tests/` | Desktop smoke tests, UI tests, and TypeScript regression tests. |
| `upstream/dashboard/` | Python task APIs, Court Discussion, Inner Court, attachments, and runtime behavior. |
| `upstream/edict/frontend/` | React dashboard pages and interaction design. |
| `upstream/agents/` | Agent role and working rules; change carefully because this affects the core workflow. |
| `README*.md`, `SECURITY.md`, and `docs/` | User-facing documentation and operating guidance. |

Changes to the orchestration core should explain why the original approval, dispatch, audit, or Agent-memory invariant remains safe.

## Pull request checklist

- Keep the change focused and explain the user-visible result.
- Add or update regression tests for behavior changes.
- Run `npm run verify`, `npm run test:ui`, and the relevant Python tests.
- Check `git diff --check`.
- Inspect the staged diff for secrets and personal data.
- Update both the English default README and `README.zh-CN.md` when user-facing behavior changes.
- Update release notes or documentation when setup, security, compatibility, or packaging behavior changes.
- Do not include personal provider configuration, API keys, runtime data, logs, or unredacted attachments.

## Commit style

Use concise Conventional Commit-style subjects where practical:

```text
feat: add an in-app channel account editor
fix: preserve queued Inner Court replies after a partial failure
docs: clarify first-run provider setup
test: cover named channel account removal
chore: refresh packaged runtime metadata
```

## Documentation language

`README.md` is the default English project page. `README.zh-CN.md` is the Chinese companion. Keep the two documents structurally aligned enough that users can switch languages without losing setup, security, or troubleshooting information.
