import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type {
  ConvoDiffBase,
  ConvoDiffFile,
  ConvoDiffStatus,
  ConvoDiffTrack,
  ConvoDiffUndo,
  ConvoDiffView,
} from '../types'
import { diffText, isBinary, unapply } from './diff'
import type { Hunk } from './diff'

const PANE = 'convo-diff'
const TITLE = '對話 diff'
const COMMAND = 'convo-diff'
const TOOL = 'mcp__convo-diff__diff'

const trackAtom = atom({ plugin: 'convo-diff', key: 'track' } as const, null)
const viewAtom = atom({ plugin: 'convo-diff', key: 'view' } as const, null)
const openAtom = atom({ plugin: 'convo-diff', key: 'open' } as const, null)
const revertAtom = atom({ plugin: 'convo-diff', key: 'revert' } as const, null)

const DEBOUNCE_MS = 150
// A drawn tree is refused past 100,000 characters serialized: the diffs get most of it.
const RENDER_BUDGET = 60_000
const MAX_FILES_DRAWN = 200
const TOOL_BUDGET = 40_000
// The store holds 4 MiB of JSON in all, across every conversation it keeps.
const STORE_BUDGET = 3 * 1024 * 1024
const STORE_ONE = 1536 * 1024
const KEEP_CONVS = 20
// A revert keeps the text it replaced, for an undo, up to this size.
const UNDO_MAX = 1024 * 1024

const STATUS_LABEL: Record<ConvoDiffStatus, string> = {
  added: '新增',
  modified: '修改',
  deleted: '刪除',
  same: '無差異',
  lost: '無法比對',
}
// Theme keys, not raw ANSI colors, so they read on light themes too.
const STATUS_COLOR: Record<ConvoDiffStatus, string> = {
  added: 'success',
  modified: 'warning',
  deleted: 'error',
  same: 'inactive',
  lost: 'inactive',
}

type Seen = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'error'; reason: string }
type Found = { base: string | null; isLost: boolean }
type BashEdit = { path: string; hunks: Hunk[]; isCreated: boolean; isDeleted: boolean }
// What the store keeps per conversation, so a resumed conversation finds its files.
type Kept = { v: 1; at: number; track: ConvoDiffTrack }

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return (text.split('\n')[0] ?? '').slice(0, 120)
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path)
}

function absolute(path: string, cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path)) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`
}

// Forward slashes, `.` and `..` folded.
function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const head = /^[A-Za-z]:\//.test(slashed)
    ? slashed.slice(0, 3)
    : slashed.startsWith('//')
      ? '//'
      : slashed.startsWith('/')
        ? '/'
        : ''
  const parts: string[] = []
  for (const part of slashed.slice(head.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return head + parts.join('/')
}

// One spelling per file: Windows paths ignore case.
function keyOf(path: string): string {
  const normal = normalize(path)
  return isWindowsPath(path) ? normal.toLowerCase() : normal
}

// The path inside the repo, or null for a file outside it.
function relOf(path: string, top: string): string | null {
  const normal = normalize(path)
  const base = normalize(top).replace(/\/$/, '')
  const fold = (text: string) => (isWindowsPath(top) ? text.toLowerCase() : text)
  return fold(normal).startsWith(`${fold(base)}/`) ? normal.slice(base.length + 1) : null
}

let topCache: string | null = null

// The repo this session works in: git's top level above where it started, else that folder itself.
async function topOf($: EngineInterface): Promise<string> {
  if (topCache !== null) return topCache
  const root = await $.session.root()
  let found = ''
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: root, timeoutMs: 10_000 })
    if (ran.exitCode === 0) found = ran.stdout.trim()
  } catch {
    // No git here: the folder the session started in is the repo.
  }
  // An MSYS git spells D:\x as /d/x.
  const msys = /^\/([A-Za-z])\/(.*)$/.exec(found)
  if (msys !== null && /^[A-Za-z]:/.test(root)) found = `${msys[1]}:/${msys[2]}`
  const isAbove = found !== '' && (keyOf(found) === keyOf(root) || relOf(root, found) !== null)
  topCache = isAbove ? found : root
  return topCache
}

async function look($: EngineInterface, path: string): Promise<Seen> {
  try {
    return { kind: 'text', text: await $.fs.read(path) }
  } catch (error) {
    const isThere = await $.fs.exists(path).catch(() => true)
    return isThere ? { kind: 'error', reason: reasonOf(error) } : { kind: 'missing' }
  }
}

function sameSeen(a: Seen, b: Seen): boolean {
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text
  if (a.kind === 'error' && b.kind === 'error') return a.reason === b.reason
  return a.kind === b.kind
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

// What a file tool's own record says the file held before the call.
function foundIn(tool: string, result: unknown): { path: string; found: Found } | null {
  const r = record(result)
  if (r === null || r.staged === true) return null
  if (tool === 'Edit' && typeof r.filePath === 'string') {
    if (typeof r.originalFile === 'string') return { path: r.filePath, found: { base: r.originalFile, isLost: false } }
    // An Edit with an empty old_string is how a file gets created.
    const isNew = r.oldString === ''
    return { path: r.filePath, found: { base: null, isLost: !isNew } }
  }
  if (tool === 'Write' && typeof r.filePath === 'string') {
    if (r.type === 'create') return { path: r.filePath, found: { base: null, isLost: false } }
    const isKept = typeof r.originalFile === 'string'
    return { path: r.filePath, found: { base: isKept ? (r.originalFile as string) : null, isLost: !isKept } }
  }
  if (tool === 'NotebookEdit' && typeof r.notebook_path === 'string') {
    const isKept = typeof r.original_file === 'string'
    return { path: r.notebook_path, found: { base: isKept ? (r.original_file as string) : null, isLost: !isKept } }
  }
  return null
}

function isHunk(value: unknown): value is Hunk {
  const r = record(value)
  return (
    r !== null &&
    typeof r.oldStart === 'number' &&
    typeof r.oldLines === 'number' &&
    typeof r.newStart === 'number' &&
    typeof r.newLines === 'number' &&
    Array.isArray(r.lines) &&
    r.lines.every(line => typeof line === 'string')
  )
}

// The working-tree changes the engine saw a Bash command make (an internal field: read with care).
function bashEditsOf(result: unknown): { files: BashEdit[]; more: string[] } {
  const diff = record(record(result)?.bashEditDiff)
  if (diff === null || diff.unavailable === true || diff.skipped === true) return { files: [], more: [] }
  const files: BashEdit[] = []
  for (const one of Array.isArray(diff.files) ? diff.files : []) {
    const r = record(one)
    if (r === null || typeof r.filePath !== 'string') continue
    const hunks = Array.isArray(r.hunks) ? r.hunks.filter(isHunk) : []
    files.push({ path: r.filePath, hunks, isCreated: r.created === true, isDeleted: r.deleted === true })
  }
  const shown = new Set(files.map(file => keyOf(file.path)))
  const changed = Array.isArray(diff.changedFiles) ? diff.changedFiles : []
  const more = changed.filter((path): path is string => typeof path === 'string' && !shown.has(keyOf(path)))
  return { files, more }
}

function isTracked(track: ConvoDiffTrack, path: string): boolean {
  const key = keyOf(path)
  return track.files.some(file => file.key === key)
}

// The first touch decides a file's base; later touches leave it alone, and files outside the repo never count.
function withBase(track: ConvoDiffTrack, top: string, path: string, found: Found): ConvoDiffTrack {
  if (relOf(path, top) === null || isTracked(track, path)) return track
  const seq = track.seq + 1
  const file: ConvoDiffBase = { key: keyOf(path), path, base: found.base, isLost: found.isLost, seq }
  return { ...track, seq, files: [...track.files, file] }
}

function storeKey(conv: number): string {
  return `conv:${conv}`
}

let queue: Promise<unknown> = Promise.resolve()

// Tracking, refreshing and the store all touch the same values: one at a time.
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

const cache = new Map<string, { base: string | null; isLost: boolean; seen: Seen; file: ConvoDiffFile }>()

async function persist($: EngineInterface, track: ConvoDiffTrack): Promise<void> {
  const encoder = new TextEncoder()
  const sizeOf = (value: unknown) => encoder.encode(JSON.stringify(value) ?? '').length
  const at = await $.clock.now()
  let kept: Kept = { v: 1, at, track }
  // One conversation may not crowd out the rest: its largest bases are dropped first.
  if (sizeOf(kept) > STORE_ONE) {
    const files = [...track.files]
    const order = files.map((_, index) => index).sort((x, y) => (files[y]?.base?.length ?? 0) - (files[x]?.base?.length ?? 0))
    for (const index of order) {
      const file = files[index]
      if (file === undefined) continue
      files[index] = { ...file, base: null, isLost: true }
      kept = { v: 1, at, track: { ...track, files } }
      if (sizeOf(kept) <= STORE_ONE) break
    }
  }
  const mine = storeKey(track.conv)
  const others: { key: string; at: number; size: number }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('conv:') || key === mine) continue
    const value = await $.store.get(key)
    others.push({ key, at: Number(record(value)?.at ?? 0), size: sizeOf(value) })
  }
  let total = sizeOf(kept)
  let count = 1
  for (const other of others.sort((x, y) => y.at - x.at)) {
    if (count < KEEP_CONVS && total + other.size <= STORE_BUDGET) {
      total += other.size
      count += 1
    } else {
      await $.store.delete(other.key)
    }
  }
  await $.store.set(mine, kept)
}

// A file Bash changed first, as hunks to undo once the text those commands left is known.
type Chain = { path: string; steps: Hunk[][] }

// `after` is what the last command left: null for no file, undefined when unknown.
function undoChain(chain: Chain, after: string | null | undefined): Found {
  if (after === undefined) return { base: null, isLost: true }
  let text = after ?? ''
  for (let index = chain.steps.length - 1; index >= 0; index--) {
    const hunks = chain.steps[index] ?? []
    const before = hunks.length === 0 ? null : unapply(text, hunks)
    if (before === null) return { base: null, isLost: true }
    text = before
  }
  return { base: text, isLost: false }
}

// Files the transcript shows this conversation changed before this process followed it (the mod enabled late).
async function adopt($: EngineInterface, track: ConvoDiffTrack, top: string): Promise<ConvoDiffTrack> {
  const messages = await $.session.messages().catch(() => [])
  const cwd = await $.session.cwd()
  const chains = new Map<string, Chain>()
  let grown = track
  for (const message of messages) {
    for (const use of message.toolUses ?? []) {
      if (use.tool === 'Bash') {
        const edits = bashEditsOf(use.result)
        for (const edit of edits.files) {
          const path = absolute(edit.path, cwd)
          const chain = chains.get(keyOf(path))
          if (chain !== undefined) chain.steps.push(edit.hunks)
          else if (relOf(path, top) === null || isTracked(grown, path)) continue
          else if (edit.isCreated) grown = withBase(grown, top, path, { base: null, isLost: false })
          else chains.set(keyOf(path), { path, steps: [edit.hunks] })
        }
        for (const changed of edits.more) {
          const path = absolute(changed, cwd)
          if (!chains.has(keyOf(path))) grown = withBase(grown, top, path, { base: null, isLost: true })
        }
        continue
      }
      const seen = foundIn(use.tool, use.result)
      if (seen === null) continue
      const chain = chains.get(keyOf(seen.path))
      if (chain === undefined) {
        grown = withBase(grown, top, seen.path, seen.found)
        continue
      }
      // A file tool starts from the text the Bash commands before it left.
      chains.delete(keyOf(seen.path))
      grown = withBase(grown, top, chain.path, undoChain(chain, seen.found.isLost ? undefined : seen.found.base))
    }
  }
  // Nothing touched these after their commands: they still hold what the commands left.
  for (const chain of chains.values()) {
    const seen = await look($, chain.path)
    const after = seen.kind === 'text' ? seen.text : seen.kind === 'missing' ? null : undefined
    grown = withBase(grown, top, chain.path, undoChain(chain, after))
  }
  return grown
}

function inRepo(track: ConvoDiffTrack, top: string): ConvoDiffTrack {
  const files = track.files.filter(file => relOf(file.path, top) !== null)
  return files.length === track.files.length ? track : { ...track, files }
}

// This conversation's files: the session's, else what the store kept for it (a resume), plus what the transcript shows.
async function ensure($: EngineInterface): Promise<ConvoDiffTrack> {
  const { startedAt: conv } = await $.session.usage()
  const top = await topOf($)
  const held = await read($, trackAtom)
  if (held !== null && held.conv === conv) {
    // Files outside the repo, followed before they stopped counting, drop out.
    const pruned = inRepo(held, top)
    if (pruned !== held) await update($, trackAtom, () => pruned)
    return pruned
  }

  const kept = record(await $.store.get(storeKey(conv)))
  const keptTrack = record(kept?.track)
  const start: ConvoDiffTrack =
    kept?.v === 1 && keptTrack?.conv === conv && Array.isArray(keptTrack.files)
      ? inRepo(keptTrack as ConvoDiffTrack, top)
      : { conv, seq: 0, files: [] }
  const track = await adopt($, start, top)
  cache.clear()
  await update($, trackAtom, () => track)
  await update($, viewAtom, () => null)
  await update($, openAtom, () => ({ conv, keys: {} }))
  await update($, revertAtom, () => ({ conv, confirm: null, undo: {} }))
  if (track.files.length > start.files.length) await persist($, track)

  return track
}

async function keep($: EngineInterface, before: ConvoDiffTrack, after: ConvoDiffTrack): Promise<void> {
  if (after === before) return
  await update($, trackAtom, () => after)
  await persist($, after)
}

function describe(base: ConvoDiffBase, seen: Seen, top: string): ConvoDiffFile {
  const file: ConvoDiffFile = {
    key: base.key,
    path: base.path,
    rel: relOf(base.path, top) ?? normalize(base.path),
    status: 'modified',
    isBinary: false,
    added: 0,
    removed: 0,
    chunks: [],
    hiddenLines: 0,
    note: null,
    seq: base.seq,
  }
  if (base.isLost) return { ...file, status: 'lost', note: '修改前的內容沒留下來（太大、被 shell 指令改的，或重開後沒保留），沒辦法比對' }
  if (seen.kind === 'error') return { ...file, status: 'lost', note: `讀不到現在的內容：${seen.reason}` }

  const before = base.base
  const after = seen.kind === 'text' ? seen.text : null
  if (before === null && after === null) return { ...file, status: 'same', note: '建立之後又刪掉了' }
  if (before === after) return { ...file, status: 'same', note: '改了又改回來，現在跟修改前一樣' }
  const status: ConvoDiffStatus = before === null ? 'added' : after === null ? 'deleted' : 'modified'
  if (isBinary(before) || isBinary(after)) return { ...file, status, isBinary: true, note: '二進位檔案，不顯示內容' }

  const diff = diffText(before, after)
  const note = diff.added + diff.removed === 0 ? '只有換行符號（CRLF／LF）或檔尾換行不一樣' : null
  return { ...file, status, ...diff, note }
}

function totals(files: readonly ConvoDiffFile[]): { changed: number; added: number; removed: number } {
  let changed = 0
  let added = 0
  let removed = 0
  for (const file of files) {
    if (file.status === 'same') continue
    changed += 1
    added += file.added
    removed += file.removed
  }
  return { changed, added, removed }
}

function statusLine(files: readonly ConvoDiffFile[]): string | undefined {
  const { changed, added, removed } = totals(files)
  if (changed === 0) return undefined
  return `這個對話改了 ${changed} 個檔案 +${added} -${removed}（/${COMMAND} 看 diff）`
}

// Re-reads the files named (or all of them) and redraws what changed.
async function refresh($: EngineInterface, keys: ReadonlySet<string> | 'all'): Promise<void> {
  const track = await read($, trackAtom)
  if (track === null) return
  const top = await topOf($)
  const prior = await read($, viewAtom)
  const drawn = new Map((prior?.conv === track.conv ? prior.files : []).map(file => [file.key, file]))

  const files: ConvoDiffFile[] = []
  for (const base of inRepo(track, top).files) {
    const old = drawn.get(base.key)
    if (keys !== 'all' && !keys.has(base.key) && old !== undefined) {
      files.push(old)
      continue
    }
    const seen = await look($, base.path)
    const hit = cache.get(base.key)
    if (hit !== undefined && hit.base === base.base && hit.isLost === base.isLost && sameSeen(hit.seen, seen)) {
      files.push(hit.file)
      continue
    }
    const file = describe(base, seen, top)
    cache.set(base.key, { base: base.base, isLost: base.isLost, seen, file })
    files.push(file)
  }

  $.ui.status(statusLine(files))
  if (prior !== null && prior.conv === track.conv && JSON.stringify(prior.files) === JSON.stringify(files)) return
  const view: ConvoDiffView = { conv: track.conv, at: await $.clock.now(), files }
  await update($, viewAtom, () => view)
}

let pending: Set<string> | 'all' | null = null
let timer: Timer | null = null

// Edits come in runs: one refresh shortly after the last of them, off the tool call's path.
function schedule($: EngineInterface, keys: readonly string[] | 'all'): void {
  pending = keys === 'all' || pending === 'all' ? 'all' : new Set([...(pending ?? []), ...keys])
  if (timer !== null) return
  timer = $.clock.after(DEBOUNCE_MS, () => {
    timer = null
    const due = pending ?? 'all'
    pending = null
    void serial(() => refresh($, due)).catch(error => $.ui.log(`refresh failed: ${reasonOf(error)}`, { to: 'debug' }))
  })
}

function patchText(files: readonly ConvoDiffFile[], filter: string): string {
  const shown = files.filter(file => filter === '' || file.rel.toLowerCase().includes(filter.toLowerCase()))
  const { changed, added, removed } = totals(shown)
  if (shown.length === 0) {
    return filter === ''
      ? 'convo-diff: this conversation has not changed any file yet.'
      : `convo-diff: no file this conversation changed matches "${filter}".`
  }
  const out = [
    `convo-diff: ${changed} file(s) changed in this conversation (+${added} -${removed}), each compared with its content before this conversation first changed it.`,
  ]
  let size = out[0]?.length ?? 0
  for (const file of shown) {
    const lines: string[] = ['']
    if (file.status === 'same' || file.status === 'lost' || file.isBinary) {
      lines.push(`# ${file.rel}: ${file.status === 'same' ? 'no net change' : file.isBinary ? `binary file ${file.status}` : 'no snapshot of its content before'}`)
    } else {
      lines.push(file.status === 'added' ? '--- /dev/null' : `--- a/${file.rel}`)
      lines.push(file.status === 'deleted' ? '+++ /dev/null' : `+++ b/${file.rel}`)
      if (file.note !== null) lines.push(`# ${file.note}`)
      lines.push(...file.chunks)
      if (file.hiddenLines > 0) lines.push(`# ... ${file.hiddenLines} more diff lines not shown`)
    }
    const text = lines.join('\n')
    if (size + text.length > TOOL_BUDGET) {
      out.push('', `# ... cut here: pass a path to see the rest`)
      break
    }
    out.push(text)
    size += text.length
  }
  return out.join('\n')
}

function canExplain(file: ConvoDiffFile): boolean {
  return file.chunks.length > 0 && !file.isBinary
}

// A binary file's base went through text and may not survive the trip back.
function canRevert(file: ConvoDiffFile): boolean {
  return (file.status === 'modified' || file.status === 'added' || file.status === 'deleted') && !file.isBinary
}

// The question the Explain button sends: answered in the conversation, where it can be followed up, by the
// session's own model, which reads the net change through this plugin's tool rather than a pasted copy.
function explainPrompt(file: ConvoDiffFile): string {
  const path = `\`${file.rel}\``
  const ask =
    file.status === 'added'
      ? `請解釋這個對話新增的 ${path}：它是做什麼的、為什麼需要它、有什麼要注意的。`
      : file.status === 'deleted'
        ? `請解釋這個對話為什麼刪除 ${path}，刪掉之後有什麼要注意的。`
        : `請解釋這個對話對 ${path} 做的改動：改了什麼、為什麼這樣改、有什麼要注意的。`
  return `${ask}要看它在這個對話裡的淨改動，可以用 ${TOOL} 工具（path 填 ${file.rel}）。只要解釋，不要修改任何檔案。`
}

// Sent as the person's own question, since they pressed for it. It starts a turn of its own once the session is
// idle, and the call resolves only then: the toast comes first.
async function askInChat($: EngineInterface, file: ConvoDiffFile, isBusy: boolean): Promise<void> {
  $.ui.toast(isBusy ? `Claude 這回合結束後會解釋 ${file.rel}` : `已請 Claude 解釋 ${file.rel}`)
  try {
    await $.prompt.submit({ text: explainPrompt(file), asUser: true })
  } catch (error) {
    $.ui.toast(`沒辦法送出解釋的問題：${reasonOf(error)}`)
  }
}

// $.fs writes but never removes: the platform's own command does.
async function removeFile($: EngineInterface, path: string): Promise<void> {
  const argv = isWindowsPath(path)
    ? [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Remove-Item -LiteralPath '${path.replace(/\//g, '\\').replace(/'/g, "''")}' -Force`,
      ]
    : ['rm', '-f', '--', path]
  const ran = await $.process.run(argv, { timeoutMs: 20_000 })
  if (await $.fs.exists(path)) throw new Error(ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`)
}

// The model keeps its own picture of the files: a note in the conversation tells it what changed beneath it.
async function tellModel($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (error) {
    $.ui.log(`could not tell the model: ${reasonOf(error)}`, { to: 'debug' })
  }
}

async function setRevert($: EngineInterface, conv: number, confirm: string | null, undo?: (held: Record<string, ConvoDiffUndo>) => Record<string, ConvoDiffUndo>): Promise<void> {
  await update($, revertAtom, held => {
    const kept = held !== null && held.conv === conv ? held.undo : {}
    return { conv, confirm, undo: undo === undefined ? kept : undo({ ...kept }) }
  })
}

async function fileOf($: EngineInterface, key: string, conv: number): Promise<{ base: ConvoDiffBase; rel: string } | null> {
  const track = await read($, trackAtom)
  const base = track !== null && track.conv === conv ? track.files.find(file => file.key === key) : undefined
  if (base === undefined) return null
  return { base, rel: relOf(base.path, await topOf($)) ?? normalize(base.path) }
}

// Puts a file back as it was before this conversation first changed it, keeping what it replaced for an undo.
async function revertFile($: EngineInterface, key: string, conv: number): Promise<void> {
  await setRevert($, conv, null)
  const found = await fileOf($, key, conv)
  if (found === null || found.base.isLost) return
  const { base, rel } = found
  const seen = await look($, base.path)
  if (seen.kind === 'error') {
    $.ui.toast(`沒辦法還原 ${rel}：${seen.reason}`)
    return
  }
  const before = seen.kind === 'text' ? seen.text : null
  try {
    if (base.base !== null) await $.fs.write(base.path, base.base)
    else if (before !== null) await removeFile($, base.path)
  } catch (error) {
    $.ui.toast(`沒辦法還原 ${rel}：${reasonOf(error)}`)
    return
  }
  const canUndo = (before?.length ?? 0) <= UNDO_MAX
  await setRevert($, conv, null, undo => {
    if (canUndo) undo[key] = { before, after: base.base }
    else delete undo[key]
    return undo
  })
  const done = base.base === null ? `已刪除 ${rel}（這個對話新增的檔案）` : `已把 ${rel} 還原成這個對話改之前的樣子`
  $.ui.toast(canUndo ? done : `${done}；檔案太大，沒辦法復原`)
  await tellModel(
    $,
    base.base === null
      ? `[convo-diff] 我在 diff 面板把 ${rel} 還原了：它是這個對話新增的檔案，現在已經刪除。`
      : `[convo-diff] 我在 diff 面板把 ${rel} 還原成這個對話第一次修改它之前的內容，這個對話對它的修改都不在了。之後要改它請先重新讀取。`,
  )
  schedule($, [key])
}

// Undoes a revert, unless the file changed again since: that change would be lost.
async function undoRevert($: EngineInterface, key: string, conv: number): Promise<void> {
  const held = await read($, revertAtom)
  const undo = held !== null && held.conv === conv ? held.undo[key] : undefined
  const found = await fileOf($, key, conv)
  if (undo === undefined || found === null) return
  const { base, rel } = found
  const drop = () =>
    setRevert($, conv, held?.confirm ?? null, all => {
      delete all[key]
      return all
    })
  const seen = await look($, base.path)
  const current = seen.kind === 'text' ? seen.text : seen.kind === 'missing' ? null : undefined
  if (current !== undo.after) {
    $.ui.toast(`${rel} 在還原之後又被改過了，沒辦法復原`)
    await drop()
    return
  }
  try {
    if (undo.before !== null) await $.fs.write(base.path, undo.before)
    else if (current !== null) await removeFile($, base.path)
  } catch (error) {
    $.ui.toast(`沒辦法復原 ${rel}：${reasonOf(error)}`)
    return
  }
  await drop()
  $.ui.toast(`已復原 ${rel}`)
  await tellModel($, `[convo-diff] 我復原了剛才對 ${rel} 的還原，檔案回到還原之前的內容${undo.before === null ? '（也就是不存在）' : ''}。之後要改它請先重新讀取。`)
  schedule($, [key])
}

export const register: Register = on => {
  // The turns running now: a question asked meanwhile waits for them.
  const running = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '只看這個對話改過的檔案 diff（打開面板）',
    })
    await $.tool.register({
      name: 'diff',
      description:
        "The net unified diff of every file in this repo that this conversation changed (Edit, Write, NotebookEdit, and Bash edits the engine tracked), each file compared with its content before this conversation first changed it. Changes made outside this conversation to files it never touched are left out. Use it to review, summarize or commit only this conversation's changes.",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Only files whose path contains this text.' } },
      },
    })
    // The transcript may be long: catching up on it waits for no prompt.
    $.clock.after(0, () => {
      void serial(() => ensure($))
        .then(() => schedule($, 'all'))
        .catch(error => $.ui.log(`start failed: ${reasonOf(error)}`, { to: 'debug' }))
    })

    return next(e)
  })

  // A /clear starts another conversation: its files start over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await serial(async () => {
        cache.clear()
        await update($, trackAtom, () => null)
        await update($, viewAtom, () => null)
        await update($, revertAtom, () => null)
        $.ui.status(undefined)
      })
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    running.add(e.turnId)
    await serial(() => ensure($)).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    running.delete(e.turnId)
    if (e.agentId === undefined) schedule($, 'all')

    return result
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const top = await topOf($).catch(() => null)
    if (top === null || relOf(path, top) === null) return next(e)

    // Read before the first touch: the record afterwards cannot tell a new file from one too large to copy.
    const before = await serial(async () => {
      const track = await ensure($)
      return isTracked(track, path) ? null : look($, path)
    }).catch(() => null)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || record(ran.result)?.staged === true) return ran

    await serial(async () => {
      const track = await ensure($)
      const own = foundIn(e.tool, ran.result)?.found
      const found: Found =
        before?.kind === 'missing'
          ? { base: null, isLost: false }
          : own !== undefined && own.base !== null
            ? own
            : before?.kind === 'text'
              ? { base: before.text, isLost: false }
              : (own ?? { base: null, isLost: true })
      await keep($, track, withBase(track, top, path, found))
    }).catch(error => $.ui.log(`tracking ${path} failed: ${reasonOf(error)}`, { to: 'debug' }))
    schedule($, [keyOf(path)])

    return ran
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || ran.isReadOnly === true) return ran

    const edits = e.tool === 'Bash' ? bashEditsOf(ran.result) : { files: [], more: [] }
    if (edits.files.length > 0 || edits.more.length > 0) {
      await serial(async () => {
        const track = await ensure($)
        const top = await topOf($)
        const cwd = await $.session.cwd()
        let grown = track
        for (const edit of edits.files) {
          const path = absolute(edit.path, cwd)
          if (relOf(path, top) === null || isTracked(grown, path)) continue
          if (edit.isCreated) {
            grown = withBase(grown, top, path, { base: null, isLost: false })
            continue
          }
          const seen: Seen = edit.isDeleted ? { kind: 'missing' } : await look($, path)
          const after = seen.kind === 'text' ? seen.text : seen.kind === 'missing' ? '' : null
          const base = after === null || edit.hunks.length === 0 ? null : unapply(after, edit.hunks)
          grown = withBase(grown, top, path, { base, isLost: base === null })
        }
        for (const changed of edits.more) {
          const path = absolute(changed, cwd)
          grown = withBase(grown, top, path, { base: null, isLost: true })
        }
        await keep($, track, grown)
      }).catch(error => $.ui.log(`tracking a ${e.tool} command failed: ${reasonOf(error)}`, { to: 'debug' }))
    }
    // A command may also have changed files this conversation already follows (a formatter, a revert).
    schedule($, 'all')

    return ran
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    await serial(async () => {
      await ensure($)
      await refresh($, 'all')
    })
    const view = await read($, viewAtom)
    const filter = typeof e.path === 'string' ? e.path.trim() : ''

    return { result: patchText(view?.files ?? [], filter) }
  })

  on('command.run', { command: COMMAND }, async $ => {
    await serial(async () => {
      await ensure($)
      await refresh($, 'all')
    })
    const view = await read($, viewAtom)
    const { changed, added, removed } = totals(view?.files ?? [])
    const opened = await $.ui.open({ id: PANE, title: TITLE, rows: 30, focus: true })
    const head = changed === 0 ? '這個對話還沒有改任何檔案' : `這個對話改了 ${changed} 個檔案（+${added} -${removed}）`

    return { text: opened.isPlaced ? `${head}，diff 在面板裡。` : `${head}；面板還沒顯示：${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const open = await read($, openAtom)
    const reverts = await read($, revertAtom)
    const files = view?.files ?? []

    if (view === null || files.length === 0) {
      return (
        <Box flexDirection="column">
          <Text>這個對話還沒有改任何檔案。</Text>
          <Text dimColor>
            之後用 Edit、Write、NotebookEdit 或 Bash 改到 repo 裡的檔案會列在這裡，每個檔案都跟它在這個對話第一次被改之前的內容比。
          </Text>
        </Box>
      )
    }

    const conv = view.conv
    const hasBody = (file: ConvoDiffFile) => file.chunks.length > 0
    const choiceOf = (file: ConvoDiffFile) => (open !== null && open.conv === conv ? open.keys[file.key] : undefined)
    const isOpenOf = (file: ConvoDiffFile) => hasBody(file) && choiceOf(file) !== false
    const anyOpen = files.some(isOpenOf)
    const toggle = (file: ConvoDiffFile) =>
      update($, openAtom, held => {
        const keys = held !== null && held.conv === conv ? held.keys : {}
        return { conv, keys: { ...keys, [file.key]: keys[file.key] === false } }
      })
    const setAll = (isOpen: boolean) =>
      update($, openAtom, () => ({ conv, keys: Object.fromEntries(files.map(file => [file.key, isOpen])) }))
    const { changed, added, removed } = totals(files)
    const confirming = reverts !== null && reverts.conv === conv ? reverts.confirm : null
    const undos = reverts !== null && reverts.conv === conv ? reverts.undo : {}

    let budget = RENDER_BUDGET
    const rows = files.slice(0, MAX_FILES_DRAWN).map((file, index) => {
      const isOpen = isOpenOf(file)
      const cost = file.chunks.reduce((sum, chunk) => sum + JSON.stringify(chunk).length, 0)
      const fits = cost <= budget
      if (isOpen && fits) budget -= cost
      const arrow = hasBody(file) ? (isOpen ? '▾' : '▸') : '·'
      const isConfirming = confirming === file.key

      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button
              plain
              key={`f${index}`}
              label={`${arrow} ${file.rel}`}
              dimColor={file.status === 'same' || file.status === 'lost'}
              onPress={() => toggle(file)}
            />
            <Text color={STATUS_COLOR[file.status]}>{STATUS_LABEL[file.status]}</Text>
            {file.added > 0 && <Text color="success">{`+${file.added}`}</Text>}
            {file.removed > 0 && <Text color="error">{`-${file.removed}`}</Text>}
            {canExplain(file) && (
              <Button
                key={`x${index}`}
                label="解釋"
                onPress={() => {
                  // Off the press: the question is answered in the conversation, not here.
                  $.clock.after(0, () => void askInChat($, file, running.size > 0))
                }}
              />
            )}
            {canRevert(file) && !isConfirming && (
              <Button key={`r${index}`} label="還原" onPress={() => void setRevert($, conv, file.key)} />
            )}
            {undos[file.key] !== undefined && (
              <Button key={`u${index}`} label="復原" onPress={() => void undoRevert($, file.key, conv)} />
            )}
          </Box>
          {isConfirming && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              <Text color="warning">
                {file.status === 'added'
                  ? `刪除 ${file.rel}？它是這個對話新增的檔案。`
                  : `把 ${file.rel} 還原成這個對話改之前的內容？`}
              </Text>
              <Button
                key={`rc${index}`}
                variant="primary"
                label={file.status === 'added' ? '確定刪除' : '確定還原'}
                onPress={() => void revertFile($, file.key, conv)}
              />
              <Button key={`rn${index}`} label="取消" onPress={() => void setRevert($, conv, null)} />
            </Box>
          )}
          {file.note !== null && (isOpen || !hasBody(file)) && <Text dimColor>{file.note}</Text>}
          {isOpen && fits && file.chunks.map(chunk => <Code source={chunk} format="diff" path={file.path} />)}
          {isOpen && fits && file.hiddenLines > 0 && (
            <Text dimColor>{`… 還有 ${file.hiddenLines} 行 diff 太長沒顯示`}</Text>
          )}
          {isOpen && !fits && <Text dimColor>（這個檔案的 diff 太長，先收合上面幾個檔案再看它）</Text>}
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold>{changed === 0 ? '這個對話改過的檔案現在都跟原本一樣' : `這個對話改了 ${changed} 個檔案`}</Text>
          {added > 0 && <Text color="success">{`+${added}`}</Text>}
          {removed > 0 && <Text color="error">{`-${removed}`}</Text>}
          <Button key="refresh" label="重新整理" onPress={() => void serial(() => refresh($, 'all'))} />
          <Button key="fold" label={anyOpen ? '全部收合' : '全部展開'} onPress={() => setAll(!anyOpen)} />
          <Button key="close" role="dismiss" label="關閉" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {rows}
        {files.length > MAX_FILES_DRAWN && <Text dimColor>{`… 還有 ${files.length - MAX_FILES_DRAWN} 個檔案沒列出來`}</Text>}
      </Box>
    )
  })
}
