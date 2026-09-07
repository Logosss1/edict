# Notices

## Upstream EDICT

Edict_InnerCourt is a desktop adaptation of [cft0808/edict](https://github.com/cft0808/edict). The upstream orchestration code, Agent roles, and license notice are retained under [`upstream/`](upstream/) and [`upstream/LICENSE`](upstream/LICENSE).

The Three Departments and Six Ministries workflow is the core design of EDICT. Edict_InnerCourt adds a macOS application shell, packaged runtime, in-app configuration, Inner Court controls, record management, and local security boundaries around that core.

The `upstream/` name is a local repository layout choice, not a requirement imposed by GitHub or by the fork relationship. It is retained because the desktop build currently packages and imports the EDICT-derived core from that path.

## Runtime and third-party components

The macOS application bundles Node.js, Python, OpenClaw, Electron, and other third-party components. Those components remain subject to their own licenses. The packaging process collects runtime license files under the generated application resources; users should review those notices when redistributing a build.
