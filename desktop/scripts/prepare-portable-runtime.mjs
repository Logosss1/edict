#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const desktopDirectory = join(dirname(fileURLToPath(import.meta.url)), '..')
const portableDirectory = join(desktopDirectory, 'portable-runtime')
const cacheDirectory = join(desktopDirectory, '.portable-runtime-cache')
const sharedDirectory = join(portableDirectory, 'shared')

const NODE_VERSION = '24.19.0'
const OPENCLAW_VERSION = '2026.7.1-2'
const PYTHON_RELEASE = '20260901'
const PYTHON_VERSION = '3.13.15'

const NODE_SHA256 = {
  darwin: {
    arm64: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
    x64: 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
  },
  linux: {
    x64: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647',
  },
  win32: {
    x64: '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73',
  },
}
const PYTHON_SHA256 = {
  darwin: {
    arm64: 'd3904bd6a072246e07aa0bdadee9a14e80521e42a943c0848059feb16a2816dc',
    x64: 'f712a9143c8a5d248438ec7921a0b48d548bca4f1337d33c690d28c2d0504137',
  },
  linux: {
    x64: '8a689a077337bea6d1c4bc0b7df1d52fcaa28f5f67e50df8bf417c1e3f9d8874',
  },
  win32: {
    x64: '63d263ab0162f34a241a56dc5b283c22d6e131f5516117e6a921350c69ba7d4f',
  },
}

const PLATFORM_CONFIG = {
  darwin: {
    nodePlatform: 'darwin',
    nodeArchive: 'tar.gz',
    nodeBinary: join('bin', 'node'),
    pythonTarget: (arch) => `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`,
    pythonBinary: join('bin', 'python3'),
    launcher: 'openclaw',
  },
  linux: {
    nodePlatform: 'linux',
    nodeArchive: 'tar.xz',
    nodeBinary: join('bin', 'node'),
    pythonTarget: () => 'x86_64-unknown-linux-gnu',
    pythonBinary: join('bin', 'python3'),
    launcher: 'openclaw',
  },
  win32: {
    nodePlatform: 'win',
    nodeArchive: 'zip',
    nodeBinary: 'node.exe',
    pythonTarget: () => 'x86_64-pc-windows-msvc',
    pythonBinary: 'python.exe',
    launcher: 'openclaw.cmd',
  },
}

const PLATFORM_ARCHITECTURES = {
  darwin: ['arm64', 'x64'],
  linux: ['x64'],
  win32: ['x64'],
}

function fail(message) {
  throw new Error(`[portable-runtime] ${message}`)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function downloadVerified(url, destination, expected) {
  await mkdir(dirname(destination), { recursive: true })
  if (await exists(destination) && await sha256(destination) === expected) return
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) fail(`下载运行时失败（HTTP ${response.status}）：${url}`)
  const data = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== expected) fail(`运行时校验失败：${url}`)
  const temporary = `${destination}.${process.pid}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  await rename(temporary, destination)
}

async function extractArchive(archive, destination) {
  await mkdir(destination, { recursive: true })
  const hostTar = process.platform === 'win32' ? 'tar' : '/usr/bin/tar'
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await execFileAsync(hostTar, ['-xf', archive, '-C', destination], { maxBuffer: 16 * 1024 })
    } else {
      await execFileAsync('/usr/bin/unzip', ['-q', archive, '-d', destination], { maxBuffer: 16 * 1024 })
    }
    return
  }
  const flag = archive.endsWith('.tar.xz') ? '-xJf' : '-xzf'
  await execFileAsync(hostTar, [flag, archive, '-C', destination], { maxBuffer: 16 * 1024 })
}

async function ensureNode(platform, arch, archDirectory) {
  const config = PLATFORM_CONFIG[platform]
  const filename = `node-v${NODE_VERSION}-${config.nodePlatform}-${arch}.${config.nodeArchive}`
  const archive = join(cacheDirectory, filename)
  await downloadVerified(`https://nodejs.org/dist/v${NODE_VERSION}/${filename}`, archive, NODE_SHA256[platform]?.[arch])
  const staging = await mkdtemp(join(tmpdir(), 'edict-node-'))
  try {
    await extractArchive(archive, staging)
    const extracted = join(staging, filename.slice(0, -`.${config.nodeArchive}`.length))
    const nodePath = join(archDirectory, 'bin', platform === 'win32' ? 'node.exe' : 'node')
    await mkdir(dirname(nodePath), { recursive: true })
    await copyFile(join(extracted, config.nodeBinary), nodePath)
    if (platform !== 'win32') await chmod(nodePath, 0o755)
    const license = join(extracted, 'LICENSE')
    if (await exists(license)) {
      await mkdir(join(sharedDirectory, 'licenses'), { recursive: true })
      await copyFile(license, join(sharedDirectory, 'licenses', `node-${platform}-${arch}-LICENSE.txt`))
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function ensurePython(platform, arch, archDirectory) {
  const config = PLATFORM_CONFIG[platform]
  const filename = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${config.pythonTarget(arch)}-install_only_stripped.tar.gz`
  const archive = join(cacheDirectory, filename)
  const encodedFilename = encodeURIComponent(filename)
  await downloadVerified(`https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encodedFilename}`, archive, PYTHON_SHA256[platform]?.[arch])
  const staging = await mkdtemp(join(tmpdir(), 'edict-python-'))
  try {
    await extractArchive(archive, staging)
    const extracted = join(staging, 'python')
    if (!(await exists(join(extracted, config.pythonBinary)))) fail(`Python 运行时结构异常：${filename}`)
    await cp(extracted, join(archDirectory, 'python'), { recursive: true, dereference: true })
    if (platform !== 'win32') await chmod(join(archDirectory, 'python', config.pythonBinary), 0o755)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function ensureOpenClaw() {
  const installDirectory = join(sharedDirectory, 'openclaw')
  const entry = join(installDirectory, 'node_modules', 'openclaw', 'openclaw.mjs')
  let installedVersion = ''
  try {
    installedVersion = JSON.parse(await readFile(join(installDirectory, 'node_modules', 'openclaw', 'package.json'), 'utf8')).version || ''
  } catch {}
  if (installedVersion === OPENCLAW_VERSION && await exists(entry)) return entry

  await rm(installDirectory, { recursive: true, force: true })
  await mkdir(installDirectory, { recursive: true })
  try {
    await execFileAsync('npm', [
      'install', '--prefix', installDirectory, '--no-save', '--no-package-lock',
      '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
      `openclaw@${OPENCLAW_VERSION}`,
    ], {
      cwd: desktopDirectory,
      env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
      maxBuffer: 128 * 1024,
    })
  } catch (error) {
    const details = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : ''
    fail(`安装 OpenClaw ${OPENCLAW_VERSION} 失败${details ? `：${details.trim().slice(-1200)}` : ''}`)
  }
  if (!(await exists(entry))) fail(`OpenClaw 安装结果缺少 ${entry}`)
  return entry
}

async function verifyOpenClaw(platform, nodePath, entry, arch) {
  if (platform !== process.platform) {
    console.log(`[portable-runtime] ${platform}/${arch} target verification skipped on ${process.platform}`)
    return
  }
  try {
    const { stdout } = await execFileAsync(nodePath, [entry, '--version'], {
      env: { ...process.env, PATH: dirname(nodePath), EDICT_AUTO_DISPATCH: '0' },
      timeout: 20_000,
      maxBuffer: 8 * 1024,
    })
    const version = stdout.match(/OpenClaw\s+([^\s(]+)/)?.[1] || ''
    if (version !== OPENCLAW_VERSION) fail(`${arch} OpenClaw 版本不匹配：${version || 'unknown'}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`${arch} OpenClaw 启动验证失败：${message.slice(0, 800)}`)
  }
}

async function writeLauncher(platform, archDirectory, entry) {
  const config = PLATFORM_CONFIG[platform]
  const launcher = join(archDirectory, 'bin', config.launcher)
  const content = platform === 'win32' ? [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    'if exist "%SCRIPT_DIR%..\\openclaw\\node_modules\\openclaw\\openclaw.mjs" (',
    '  set "OPENCLAW_ENTRY=%SCRIPT_DIR%..\\openclaw\\node_modules\\openclaw\\openclaw.mjs"',
    ') else (',
    '  set "OPENCLAW_ENTRY=%SCRIPT_DIR%..\\..\\shared\\openclaw\\node_modules\\openclaw\\openclaw.mjs"',
    ')',
    '"%SCRIPT_DIR%node.exe" "%OPENCLAW_ENTRY%" %*',
    '',
  ].join(String.fromCharCode(10)) : `#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$script_dir/../openclaw/node_modules/openclaw/openclaw.mjs" ]; then
  openclaw_entry="$script_dir/../openclaw/node_modules/openclaw/openclaw.mjs"
else
  openclaw_entry="$script_dir/../../shared/openclaw/node_modules/openclaw/openclaw.mjs"
fi
exec "$script_dir/node" "$openclaw_entry" "$@"
`
  await writeFile(launcher, content, { mode: platform === 'win32' ? 0o644 : 0o755 })
  if (platform !== 'win32') {
    await chmod(launcher, 0o755)
    await chmod(entry, 0o644)
  }
}

async function prepare(platform, arch) {
  const archDirectory = join(portableDirectory, arch)
  await rm(archDirectory, { recursive: true, force: true })
  await mkdir(archDirectory, { recursive: true })
  await ensureNode(platform, arch, archDirectory)
  await ensurePython(platform, arch, archDirectory)
  const entry = await ensureOpenClaw()
  await writeLauncher(platform, archDirectory, entry)
  await verifyOpenClaw(platform, join(archDirectory, 'bin', platform === 'win32' ? 'node.exe' : 'node'), entry, arch)
  await writeFile(join(archDirectory, 'runtime-manifest.json'), `${JSON.stringify({ platform, arch, node: NODE_VERSION, python: PYTHON_VERSION, openclaw: OPENCLAW_VERSION }, null, 2)}\n`, { mode: 0o644 })
  console.log(`[portable-runtime] ${platform}/${arch} ready: Node ${NODE_VERSION}, Python ${PYTHON_VERSION}, OpenClaw ${OPENCLAW_VERSION}`)
}

const requested = process.argv.slice(2)
const platformOptionIndex = requested.indexOf('--platform')
const targetPlatform = platformOptionIndex >= 0 ? requested[platformOptionIndex + 1] : process.platform
if (!PLATFORM_CONFIG[targetPlatform]) fail(`不支持的目标平台：${targetPlatform}`)
const archOptionIndex = requested.indexOf('--arch')
const archOption = archOptionIndex >= 0 ? requested[archOptionIndex + 1] : ''
const architectures = requested.includes('--all')
  ? PLATFORM_ARCHITECTURES[targetPlatform]
  : [archOption || process.arch]
for (const arch of architectures) {
  if (!PLATFORM_ARCHITECTURES[targetPlatform].includes(arch)) fail(`不支持的 ${targetPlatform} 架构：${arch}`)
}

await mkdir(cacheDirectory, { recursive: true })
await mkdir(sharedDirectory, { recursive: true })
await ensureOpenClaw()
for (const arch of architectures) await prepare(targetPlatform, arch)
