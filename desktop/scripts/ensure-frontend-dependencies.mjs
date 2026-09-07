import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDirectory = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const frontendDirectory = join(desktopDirectory, '..', 'upstream', 'edict', 'frontend')
if (!existsSync(join(frontendDirectory, 'node_modules'))) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', frontendDirectory, 'ci'], { stdio: 'inherit' })
}
