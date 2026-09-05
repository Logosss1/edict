import { useEffect, useRef, useState } from 'react'
import { Download, FileText, LoaderCircle, Paperclip, RefreshCw, Send, X } from 'lucide-react'
import { attachmentApi, type ChatAttachment } from '../api'

const ACCEPT = '.txt,.md,.csv,.json,.yaml,.yml,.log,.py,.js,.ts,.tsx,.jsx,.html,.css,.xml,.sql,.sh,.toml,.ini,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif'
const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
type Entry = { key: string; name: string; file?: File; meta?: ChatAttachment; progress: number; error?: string }
type Draft = { text: string; attachments: ChatAttachment[] }
const storageKey = (scope: string) => `edict-chat-draft:${scope}`
function readDraft(scope: string): Draft {
  try {
    const draft = JSON.parse(localStorage.getItem(storageKey(scope)) || '{}')
    return { text: typeof draft.text === 'string' ? draft.text : '', attachments: Array.isArray(draft.attachments) ? draft.attachments.filter((item: ChatAttachment) => item && typeof item.id === 'string' && typeof item.name === 'string').slice(0, 8) : [] }
  } catch { return { text: '', attachments: [] } }
}

export function AttachmentList({ scope, files }: { scope: string; files?: ChatAttachment[] }) {
  if (!files?.length) return null
  return <ul className="chat-attachment-list" aria-label="已发送附件">{files.map((file) => <li key={file.id}>
    {file.kind === 'image' ? <img src={attachmentApi.url(scope, file.id)} alt={file.name} width={48} height={48} loading="lazy" /> : <FileText size={18} aria-hidden="true" />}
    <div><a href={attachmentApi.url(scope, file.id)} download={file.name}>{file.name}<Download size={13} aria-hidden="true" /></a><small>{size(file.size)}{file.warning ? ` · ${file.warning}` : ''}</small></div>
  </li>)}</ul>
}

export default function ChatComposer({ scope, label, busy, paused, placeholder, sendLabel, onSend }: {
  scope: string; label: string; busy?: boolean; paused?: boolean; placeholder?: string; sendLabel: string
  onSend: (text: string, files: ChatAttachment[]) => Promise<boolean>
}) {
  const [draft] = useState(() => readDraft(scope))
  const [text, setText] = useState(draft.text)
  const [entries, setEntries] = useState<Entry[]>(draft.attachments.map((meta) => ({ key: meta.id, name: meta.name, meta, progress: 100 })))
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const controllers = useRef(new Set<AbortController>())
  const uploadLock = useRef(false)
  const sendLock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; controllers.current.forEach((controller) => controller.abort()) }
  }, [])
  useEffect(() => {
    try { localStorage.setItem(storageKey(scope), JSON.stringify({ text, attachments: entries.flatMap((entry) => entry.meta ? [entry.meta] : []) })) }
    catch { setError('本地草稿保存失败，请勿关闭当前会话。') }
  }, [scope, text, entries])

  const upload = async (entry: Entry) => {
    if (!entry.file) return
    const controller = new AbortController()
    controllers.current.add(controller)
    const update = (patch: Partial<Entry>) => {
      if (alive.current) setEntries((current) => current.map((item) => item.key === entry.key ? { ...item, ...patch } : item))
    }
    update({ error: undefined, progress: 0 })
    try {
      const meta = await attachmentApi.upload(scope, entry.file, (progress) => update({ progress }), controller.signal)
      update({ meta, progress: 100, file: undefined })
    } catch (reason) { update({ error: reason instanceof Error ? reason.message : '上传失败' }) }
    finally { controllers.current.delete(controller) }
  }
  const add = async (files: File[]) => {
    if (busy || sending || uploadLock.current || !files.length) return
    setError('')
    if (entries.length + files.length > 8) { setError('每条消息最多附加 8 个文件。'); return }
    const invalid = files.find((file) => !file.size || file.size > 10 * 1024 * 1024)
    if (invalid) { setError(`${invalid.name}：文件不能为空，且不能超过 10 MB。`); return }
    uploadLock.current = true
    setUploading(true)
    const next = files.map((file) => ({ key: crypto.randomUUID(), name: file.name, file, progress: 0 }))
    setEntries((current) => [...current, ...next])
    try { for (const entry of next) { if (!alive.current) break; await upload(entry) } }
    finally { uploadLock.current = false; if (alive.current) setUploading(false) }
  }
  const retry = async (entry: Entry) => {
    if (uploadLock.current) return
    uploadLock.current = true; setUploading(true)
    try { await upload(entry) }
    finally { uploadLock.current = false; if (alive.current) setUploading(false) }
  }
  const remove = async (entry: Entry) => {
    try {
      if (entry.meta) {
        const result = await attachmentApi.remove(scope, entry.meta.id)
        if (!result.ok) throw new Error(result.error || '移除附件失败')
      }
      setEntries((current) => current.filter((item) => item.key !== entry.key))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '移除附件失败') }
  }
  const canSend = !busy && !sending && !paused && !uploading && entries.every((entry) => entry.meta) && Boolean(text.trim() || entries.length)
  const send = async () => {
    if (!canSend || sendLock.current) return
    sendLock.current = true; setSending(true); setError('')
    try {
      if (await onSend(text.trim(), entries.flatMap((entry) => entry.meta ? [entry.meta] : []))) {
        setText(''); setEntries([])
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '发送失败，草稿已保留') }
    finally { sendLock.current = false; if (alive.current) setSending(false) }
  }
  return <div className="chat-composer" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => {
    if (event.dataTransfer.files.length) { event.preventDefault(); void add(Array.from(event.dataTransfer.files)) }
  }} onPaste={(event) => {
    if (event.clipboardData.files.length) { event.preventDefault(); void add(Array.from(event.clipboardData.files)) }
  }}>
    {error && <div className="chat-upload-error" role="alert">{error}</div>}
    {entries.length > 0 && <ul className="chat-attachment-list" aria-label="待发送附件">{entries.map((entry) => <li key={entry.key}>
      <FileText size={18} aria-hidden="true" />
      <div><strong>{entry.name}</strong><small role={entry.error ? 'alert' : 'status'}>{entry.error || (entry.meta ? `${size(entry.meta.size)}${entry.meta.warning ? ` · ${entry.meta.warning}` : ''}` : entry.progress === 100 ? '正在解析…' : `上传中 ${entry.progress}%`)}</small></div>
      {entry.error && <button type="button" className="btn btn-g" title={`重试上传 ${entry.name}`} aria-label={`重试上传 ${entry.name}`} disabled={uploading || busy || sending} onClick={() => void retry(entry)}><RefreshCw size={15} /></button>}
      <button type="button" className="btn btn-g" title={`移除 ${entry.name}`} aria-label={`移除 ${entry.name}`} disabled={uploading || busy || sending} onClick={() => void remove(entry)}><X size={15} /></button>
    </li>)}</ul>}
    <textarea name="message" autoComplete="off" aria-label={label} value={text} onChange={(event) => setText(event.target.value)} maxLength={16000} rows={2}
      placeholder={placeholder} disabled={busy || sending} onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
      }} />
    <div className="chat-composer-toolbar">
      <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} aria-label="选择附件" disabled={busy || sending || uploading} onChange={(event) => {
        void add(Array.from(event.target.files || [])); event.target.value = ''
      }} />
      <button type="button" className="btn btn-g" title="上传文件（最多 8 个，单个 10 MB）" aria-label="上传文件" disabled={busy || sending || uploading || entries.length >= 8} onClick={() => input.current?.click()}>
        {uploading ? <LoaderCircle size={17} className="chat-upload-spinner" aria-hidden="true" /> : <Paperclip size={17} aria-hidden="true" />}
      </button>
      <button type="button" className="btn btn-p" disabled={!canSend} onClick={() => void send()}><Send size={15} aria-hidden="true" />{sending ? '发送中…' : sendLabel}</button>
    </div>
  </div>
}
