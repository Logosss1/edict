#!/usr/bin/env node

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDirectory = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptArguments = process.argv.slice(2)

async function executable(file) {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function run(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, scriptArguments, { stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

const bundledPython = process.platform === 'win32'
  ? join(desktopDirectory, 'portable-runtime', process.arch, 'python', 'python.exe')
  : join(desktopDirectory, 'portable-runtime', process.arch, 'python', 'bin', 'python3')
const candidates = [
  process.env.EDICT_PYTHON,
  bundledPython,
  'python3',
].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index)

let lastError
for (const candidate of candidates) {
  if (candidate.includes('/') && !(await executable(candidate))) continue
  try {
    const result = await run(candidate)
    if (result.code === 0) process.exit(0)
    process.exit(result.code ?? 1)
  } catch (error) {
    lastError = error
  }
}

console.error(`无法启动 Python：${lastError instanceof Error ? lastError.message : '未找到可用的 Python 3'}`)
process.exit(1)
