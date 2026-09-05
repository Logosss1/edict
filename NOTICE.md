# Notices

## Upstream EDICT

Edict_InnerCourt is a desktop adaptation of [cft0808/edict](https://github.com/cft0808/edict). The upstream orchestration code, Agent roles, and license notice are retained under [`upstream/`](upstream/) and [`upstream/LICENSE`](upstream/LICENSE).

The Three Departments and Six Ministries workflow is the core design of EDICT. Edict_InnerCourt adds a macOS application shell, packaged runtime, in-app configuration, Inner Court controls, record management, and local security boundaries around that core.

## Runtime and third-party components

The macOS application bundles Node.js, Python, OpenClaw, Electron, and other third-party components. Those components remain subject to their own licenses. The packaging process collects runtime license files under the generated application resources; users should review those notices when redistributing a build.

Do not add personal provider configuration, API keys, OpenClaw user data, runtime logs, or other private data to this repository or to a Release asset.
