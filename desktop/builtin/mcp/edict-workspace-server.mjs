#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1] || 'workspace'
  : 'workspace'
const projectRoot = resolve(process.env.EDICT_PROJECT_DIR || process.cwd())
const sdkRoot = process.env.EDICT_OPENCLAW_RUNTIME_ROOT
  ? join(process.env.EDICT_OPENCLAW_RUNTIME_ROOT, 'node_modules', 'openclaw', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
  : ''

function safeRelative(value, fallback = '.') {
  const requested = typeof value === 'string' && value.trim() ? value.trim() : fallback
  if (isAbsolute(requested)) throw new Error('只允许访问当前工作区内的相对路径')
  const target = resolve(projectRoot, requested)
  const fromRoot = relative(projectRoot, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('路径超出当前工作区')
  }
  return target
}

function displayPath(target) {
  return relative(projectRoot, target) || '.'
}

async function walkFiles(root, options = {}) {
  const maxEntries = Math.min(Math.max(Number(options.maxEntries) || 200, 1), 500)
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 6, 0), 12)
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', 'release', '.venv', '__pycache__'])
  const files = []
  async function visit(directory, depth) {
    if (files.length >= maxEntries || depth > maxDepth) return
    let entries = []
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxEntries || skip.has(entry.name)) continue
      const target = join(directory, entry.name)
      if (entry.isDirectory()) await visit(target, depth + 1)
      else if (entry.isFile()) files.push(target)
    }
  }
  await visit(root, 0)
  return files
}

async function listFiles(args = {}) {
  const root = safeRelative(args.path, '.')
  const files = await walkFiles(root, args)
  return files.map(displayPath).join('\n') || '(工作区内没有可列出的文件)'
}

async function readWorkspaceFile(args = {}) {
  const target = safeRelative(args.path)
  const info = await stat(target)
  if (!info.isFile()) throw new Error('目标不是文件')
  const maxBytes = Math.min(Math.max(Number(args.maxBytes) || 200_000, 1), 500_000)
  const content = await readFile(target, 'utf8')
  return content.length > maxBytes
    ? `${content.slice(0, maxBytes)}\n\n[内容已截断；文件大小 ${content.length} 字符]`
    : content
}

async function searchWorkspace(args = {}) {
  const query = String(args.query || '').trim()
  if (!query) throw new Error('query 不能为空')
  const files = await walkFiles(safeRelative(args.path, '.'), { maxEntries: 500, maxDepth: 12 })
  const maxResults = Math.min(Math.max(Number(args.maxResults) || 50, 1), 100)
  const results = []
  for (const file of files) {
    if (results.length >= maxResults) break
    if (['.png', '.jpg', '.jpeg', '.gif', '.icns', '.zip', '.pdf'].includes(extname(file).toLowerCase())) continue
    let content = ''
    try {
      const info = await stat(file)
      if (info.size > 1_000_000) continue
      content = await readFile(file, 'utf8')
    } catch { continue }
    const index = content.toLowerCase().indexOf(query.toLowerCase())
    if (index < 0) continue
    const line = content.slice(0, index).split('\n').length
    const excerpt = content.slice(Math.max(0, index - 100), Math.min(content.length, index + query.length + 180)).replace(/\s+/g, ' ')
    results.push(`${displayPath(file)}:${line} — ${excerpt}`)
  }
  return results.join('\n') || '(没有匹配结果)'
}

function memoryRoot() {
  return safeRelative('.edict/memory')
}

function memoryName(value) {
  const name = String(value || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(name)) throw new Error('记忆名称只能包含字母、数字、点、下划线和短横线')
  return name.endsWith('.md') ? name : `${name}.md`
}

async function listMemory() {
  const root = memoryRoot()
  if (!existsSync(root)) return '(暂无工作区记忆)'
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter((item) => item.isFile()).map((item) => item.name).sort().join('\n') || '(暂无工作区记忆)'
}

async function readMemory(args = {}) {
  const file = join(memoryRoot(), memoryName(args.name))
  return readFile(file, 'utf8')
}

async function writeMemory(args = {}) {
  const name = memoryName(args.name)
  const content = String(args.content || '')
  if (!content.trim()) throw new Error('记忆内容不能为空')
  if (content.length > 100_000) throw new Error('单条工作区记忆不能超过 100000 字符')
  const root = memoryRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const file = join(root, name)
  await writeFile(file, content, { encoding: 'utf8', mode: 0o600 })
  return `已保存工作区记忆 ${displayPath(file)}`
}

async function main() {
  if (!sdkRoot || !existsSync(sdkRoot)) throw new Error('应用内置 MCP 运行时不可用')
  const [{ Server }, { StdioServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import(pathToFileURL(join(sdkRoot, 'server', 'index.js')).href),
    import(pathToFileURL(join(sdkRoot, 'server', 'stdio.js')).href),
    import(pathToFileURL(join(sdkRoot, 'types.js')).href),
  ])
  const server = new Server({ name: mode === 'memory' ? 'edict-memory' : 'edict-workspace', version: '1.0.0' }, { capabilities: { tools: {} } })
  const tools = mode === 'memory'
    ? [
        { name: 'memory_list', description: '列出当前项目工作区的共享 Markdown 记忆。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'memory_read', description: '读取当前项目工作区的一条共享记忆。', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
        { name: 'memory_write', description: '把经过整理的长期项目上下文保存到当前项目工作区。仅写入 .edict/memory。', inputSchema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'], additionalProperties: false } },
      ]
    : [
        { name: 'workspace_list_files', description: '列出当前项目工作区内的文件，自动跳过依赖和构建产物。', inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxDepth: { type: 'number' }, maxEntries: { type: 'number' } }, additionalProperties: false } },
        { name: 'workspace_read_file', description: '读取当前项目工作区内的文本文件。', inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxBytes: { type: 'number' } }, required: ['path'], additionalProperties: false } },
        { name: 'workspace_search', description: '在当前项目工作区内搜索文本并返回文件和行号。', inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'], additionalProperties: false } },
      ]
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const args = request.params.arguments || {}
    let text
    if (mode === 'memory') {
      if (name === 'memory_list') text = await listMemory()
      else if (name === 'memory_read') text = await readMemory(args)
      else if (name === 'memory_write') text = await writeMemory(args)
      else throw new Error(`未知工具: ${name}`)
    } else {
      if (name === 'workspace_list_files') text = await listFiles(args)
      else if (name === 'workspace_read_file') text = await readWorkspaceFile(args)
      else if (name === 'workspace_search') text = await searchWorkspace(args)
      else throw new Error(`未知工具: ${name}`)
    }
    return { content: [{ type: 'text', text: String(text) }] }
  })
  await server.connect(new StdioServerTransport())
}

main().catch((error) => {
  console.error(`[edict-mcp] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
