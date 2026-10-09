import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, UiOpenResult } from 'claude-code'

import type {
  ConvoDiffBase,
  ConvoDiffFile,
  ConvoDiffOpen,
  ConvoDiffStatus,
  ConvoDiffTrack,
  ConvoDiffUndo,
  ConvoDiffView,
} from '../types'
import { ALLOW, gitOpsOf, isAllowed, parseStatus, takesFile } from './clash'
import type { GitOp, Shell } from './clash'
import { diffText, isBinary, piecesOf, unapply } from './diff'
import type { Hunk } from './diff'
import { gitArgv, isLeftover, parseRaw, parseTree, sameText, withEol } from './git'
import { absolute, fromMsys, isWindowsPath, keyOf, normalize, relOf } from './paths'

const PLUGIN = 'convo-diff'
const PANE = 'convo-diff'
const TITLE = '對話 diff'
const COMMAND = 'convo-diff'
const TOOL = 'mcp__convo-diff__diff'
// The band's button that opens the pane, on the desktop.
const OPEN = 'open'

const trackAtom = atom({ plugin: 'convo-diff', key: 'track' } as const, null)
const viewAtom = atom({ plugin: 'convo-diff', key: 'view' } as const, null)
const openAtom = atom({ plugin: 'convo-diff', key: 'open' } as const, null)
const revertAtom = atom({ plugin: 'convo-diff', key: 'revert' } as const, null)

const DEBOUNCE_MS = 150
// A ring move and a click on one button this close together are one press.
const PRESS_GAP_MS = 600
// The desktop may draw the pane holding the keys before the ring move of the click that gave them arrives: a move
// this soon after is still that click.
const TAKE_MS = 500
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
const GIT_TIMEOUT_MS = 20_000
// A snapshot slower than this (past the first, which hashes every file) is too slow to take around every command.
const SNAP_SLOW_MS = 3000
// The most files one command gives a base to; past it, the rest are followed with their bases lost.
const SNAP_MAX_BASES = 100

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
// What a file is compared with: its base, or what the last commit that took it holds.
type Against = Found & { isCommitted: boolean }
type BashEdit = { path: string; hunks: Hunk[]; isCreated: boolean; isDeleted: boolean }
// What the store keeps per conversation, so a resumed conversation finds its files, and so the other conversations
// know which files are its and how to name it: its desktop session and title.
type Kept = { v: 1; at: number; track: ConvoDiffTrack; session?: string | null; title?: string | null }

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return (text.split('\n')[0] ?? '').slice(0, 120)
}

let topCache: string | null = null
let isGit = false

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
  found = fromMsys(found, root)
  const isAbove = found !== '' && (keyOf(found) === keyOf(root) || relOf(root, found) !== null)
  isGit = isAbove
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

// The working-tree changes the engine saw a Bash command make (an internal field: read with care). `isPartial`: it
// changed files the record names without their changes (`more`), or names none of (unavailable, skipped). No record
// at all is a command that changed nothing.
function bashEditsOf(result: unknown): { files: BashEdit[]; more: string[]; isPartial: boolean } {
  const diff = record(record(result)?.bashEditDiff)
  if (diff === null) return { files: [], more: [], isPartial: false }
  if (diff.unavailable === true || diff.skipped === true) return { files: [], more: [], isPartial: true }
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
  return { files, more, isPartial: more.length > 0 || Number(diff.moreFiles) > 0 }
}

function isTracked(track: ConvoDiffTrack, path: string): boolean {
  const key = keyOf(path)
  return track.files.some(file => file.key === key)
}

// The first touch decides a file's base, and the HEAD it was taken at; later touches leave them alone, and files
// outside the repo never count.
function withBase(track: ConvoDiffTrack, top: string, path: string, found: Found, head: string | null): ConvoDiffTrack {
  if (relOf(path, top) === null || isTracked(track, path)) return track
  const seq = track.seq + 1
  const file: ConvoDiffBase = { key: keyOf(path), path, base: found.base, isLost: found.isLost, seq, head }
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

// This conversation as the desktop names it: what the other conversations' warnings call it.
let who: { session: string | null; title: string | null } = { session: null, title: null }

const cache = new Map<string, { base: string | null; isLost: boolean; seen: Seen; file: ConvoDiffFile }>()
// HEAD at the last refresh: when it moves, every file is looked at again.
let lastHead: string | null | undefined

async function persist($: EngineInterface, track: ConvoDiffTrack): Promise<void> {
  const encoder = new TextEncoder()
  const sizeOf = (value: unknown) => encoder.encode(JSON.stringify(value) ?? '').length
  const at = await $.clock.now()
  let kept: Kept = { v: 1, at, track, ...who }
  // One conversation may not crowd out the rest: its largest bases are dropped first.
  if (sizeOf(kept) > STORE_ONE) {
    const files = [...track.files]
    const order = files.map((_, index) => index).sort((x, y) => (files[y]?.base?.length ?? 0) - (files[x]?.base?.length ?? 0))
    for (const index of order) {
      const file = files[index]
      if (file === undefined) continue
      files[index] = { ...file, base: null, isLost: true }
      kept = { v: 1, at, track: { ...track, files }, ...who }
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
          else if (edit.isCreated) grown = withBase(grown, top, path, { base: null, isLost: false }, null)
          else chains.set(keyOf(path), { path, steps: [edit.hunks] })
        }
        for (const changed of edits.more) {
          const path = absolute(changed, cwd)
          if (!chains.has(keyOf(path))) grown = withBase(grown, top, path, { base: null, isLost: true }, null)
        }
        continue
      }
      const seen = foundIn(use.tool, use.result)
      if (seen === null) continue
      const chain = chains.get(keyOf(seen.path))
      if (chain === undefined) {
        grown = withBase(grown, top, seen.path, seen.found, null)
        continue
      }
      // A file tool starts from the text the Bash commands before it left.
      chains.delete(keyOf(seen.path))
      grown = withBase(grown, top, chain.path, undoChain(chain, seen.found.isLost ? undefined : seen.found.base), null)
    }
  }
  // Nothing touched these after their commands: they still hold what the commands left.
  for (const chain of chains.values()) {
    const seen = await look($, chain.path)
    const after = seen.kind === 'text' ? seen.text : seen.kind === 'missing' ? null : undefined
    grown = withBase(grown, top, chain.path, undoChain(chain, after), null)
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

// HEAD now: a commit id, '' in a repo with no commit yet, null with no repo (or when git cannot say).
async function headOf($: EngineInterface): Promise<string | null> {
  const top = await topOf($)
  if (!isGit) return null
  try {
    const ran = await $.process.run(gitArgv(['rev-parse', '--verify', '-q', 'HEAD']), { cwd: top, timeoutMs: GIT_TIMEOUT_MS })
    const id = ran.stdout.trim()
    if (ran.exitCode === 0) return /^[0-9a-f]{40,64}$/.test(id) ? id : null
    return ran.exitCode === 1 ? '' : null
  } catch {
    return null
  }
}

// What a commit holds is fixed: its blobs by path, and their texts, are read once.
const treeCache = new Map<string, string | null>()
const blobCache = new Map<string, string | null>()
const CACHE_MAX = 2000
const LS_TREE_PATHS = 50

function cacheSet<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, value)
}

// The blob each path has in a commit, or null where it has none.
async function blobsIn($: EngineInterface, top: string, commit: string, rels: readonly string[]): Promise<Map<string, string | null>> {
  const fold = (rel: string) => (isWindowsPath(top) ? rel.toLowerCase() : rel)
  const missing = [...new Set(rels)].filter(rel => !treeCache.has(`${commit}:${rel}`))
  for (let at = 0; at < missing.length; at += LS_TREE_PATHS) {
    const some = missing.slice(at, at + LS_TREE_PATHS)
    const found = parseTree(await gitOut($, top, ['ls-tree', '-r', '-z', commit, '--', ...some]), fold)
    for (const rel of some) cacheSet(treeCache, `${commit}:${rel}`, found.get(fold(rel)) ?? null)
  }
  return new Map(rels.map(rel => [rel, treeCache.get(`${commit}:${rel}`) ?? null]))
}

// A blob's text, or null when git cannot hand it over whole.
async function blobText($: EngineInterface, top: string, blob: string): Promise<string | null> {
  if (!blobCache.has(blob)) cacheSet(blobCache, blob, await gitOut($, top, ['cat-file', 'blob', blob]).catch(() => null))
  return blobCache.get(blob) ?? null
}

// What each file is compared with while only what is not committed counts: its base, unless a commit since its
// first change took it. That is a commit where the file differs from the HEAD it was first changed at; with that
// HEAD unknown, a HEAD whose file differs from the base. Partial commits, amends and commits from elsewhere all come
// out the same way, as does a file the commit deleted (null).
async function againstHead(
  $: EngineInterface,
  top: string,
  bases: readonly ConvoDiffBase[],
  seen: ReadonlyMap<string, Seen>,
): Promise<Map<string, Against>> {
  const out = new Map<string, Against>(bases.map(base => [base.key, { base: base.base, isLost: base.isLost, isCommitted: false }]))
  const head = await headOf($)
  if (head === null || head === '') return out
  const moved = bases.filter(base => base.head !== head && !(base.head == null && base.isLost))
  if (moved.length === 0) return out
  const relOfBase = (base: ConvoDiffBase) => relOf(base.path, top) ?? ''
  try {
    const now = await blobsIn($, top, head, moved.map(relOfBase))
    const then = new Map<string, Map<string, string | null>>()
    for (const base of moved) {
      if (typeof base.head !== 'string' || base.head === '' || then.has(base.head)) continue
      const rels = moved.filter(other => other.head === base.head).map(relOfBase)
      then.set(base.head, await blobsIn($, top, base.head, rels))
    }
    for (const base of moved) {
      const rel = relOfBase(base)
      const blob = now.get(rel) ?? null
      const text = blob === null ? null : await blobText($, top, blob)
      if (blob !== null && text === null) continue
      if (typeof base.head === 'string') {
        const before = base.head === '' ? null : (then.get(base.head)?.get(rel) ?? null)
        if (before === blob) continue
      } else if (sameText(text, base.base)) {
        continue
      }
      const file = seen.get(base.key)
      const like = file?.kind === 'text' ? file.text : (base.base ?? '')
      out.set(base.key, { base: text === null ? null : withEol(text, like), isLost: false, isCommitted: true })
    }
  } catch (error) {
    $.ui.log(`reading HEAD failed: ${reasonOf(error)}`, { to: 'debug' })
  }
  return out
}

function describe(base: ConvoDiffBase, against: Against, seen: Seen, top: string): ConvoDiffFile {
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
    isCommitted: against.isCommitted,
  }
  if (against.isLost) return { ...file, status: 'lost', note: '修改前的內容沒留下來（太大、被 shell 指令改的，或重開後沒保留），沒辦法比對' }
  if (seen.kind === 'error') return { ...file, status: 'lost', note: `讀不到現在的內容：${seen.reason}` }

  const before = against.base
  const after = seen.kind === 'text' ? seen.text : null
  if (against.isCommitted && (before === after || (before !== null && after !== null && sameText(before, after)))) {
    return { ...file, status: 'same', note: '已經 commit 了，之後沒有再改' }
  }
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

// Re-reads the files named (or all of them) and redraws what changed. A commit since the last look redoes them all.
async function refresh($: EngineInterface, keys: ReadonlySet<string> | 'all'): Promise<void> {
  const track = await read($, trackAtom)
  if (track === null) return
  const top = await topOf($)
  const prior = await read($, viewAtom)
  const isSame = prior !== null && prior.conv === track.conv
  const head = await headOf($)
  const due = head !== lastHead ? 'all' : keys
  lastHead = head
  const drawn = new Map((isSame ? prior.files : []).map(file => [file.key, file]))
  const drawnAll = new Map((isSame ? (prior.all ?? []) : []).map(file => [file.key, file]))

  const bases = inRepo(track, top).files
  const fresh = bases.filter(base => due === 'all' || due.has(base.key) || !drawn.has(base.key) || !drawnAll.has(base.key))
  const seen = new Map<string, Seen>()
  for (const base of fresh) seen.set(base.key, await look($, base.path))
  const against = await againstHead($, top, fresh, seen)

  const files: ConvoDiffFile[] = []
  const all: ConvoDiffFile[] = []
  for (const base of bases) {
    const now = seen.get(base.key)
    const old = drawn.get(base.key)
    const oldAll = drawnAll.get(base.key)
    if (now === undefined && old !== undefined && oldAll !== undefined) {
      files.push(old)
      all.push(oldAll)
      continue
    }
    const here: Seen = now ?? { kind: 'missing' }
    const whole = described(base, { base: base.base, isLost: base.isLost, isCommitted: false }, here, top)
    const since = against.get(base.key)
    all.push(whole)
    files.push(since === undefined || !since.isCommitted ? whole : described(base, since, here, top))
  }

  // The desktop has the band's button instead: the same numbers twice would only repeat themselves.
  const surfaces = await $.session.surfaces().catch(() => [])
  $.ui.status(surfaces.includes('desktop') ? undefined : statusLine(files))
  if (isSame && JSON.stringify(prior.files) === JSON.stringify(files) && JSON.stringify(prior.all) === JSON.stringify(all)) return
  const view: ConvoDiffView = { conv: track.conv, at: await $.clock.now(), files, all }
  await update($, viewAtom, () => view)
}

// A file's diff is worked out again only when its text, or what it is compared with, changed.
function described(base: ConvoDiffBase, against: Against, seen: Seen, top: string): ConvoDiffFile {
  const key = `${against.isCommitted ? 'c' : 'b'}:${base.key}`
  const hit = cache.get(key)
  if (hit !== undefined && hit.base === against.base && hit.isLost === against.isLost && sameSeen(hit.seen, seen)) {
    return hit.file
  }
  const file = describe(base, against, seen, top)
  cache.set(key, { base: against.base, isLost: against.isLost, seen, file })
  return file
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

function patchText(view: ConvoDiffView | null, filter: string, isAll: boolean): string {
  const matches = (file: ConvoDiffFile) => filter === '' || file.rel.toLowerCase().includes(filter.toLowerCase())
  const every = ((isAll ? view?.all : view?.files) ?? []).filter(matches)
  const committed = isAll ? [] : every.filter(file => file.isCommitted && file.status === 'same')
  const shown = every.filter(file => !committed.includes(file))
  const { changed, added, removed } = totals(shown)
  if (every.length === 0) {
    return filter === ''
      ? 'convo-diff: this conversation has not changed any file yet.'
      : `convo-diff: no file this conversation changed matches "${filter}".`
  }
  const out = [
    isAll
      ? `convo-diff: ${changed} file(s) changed in this conversation (+${added} -${removed}), each compared with its content before this conversation first changed it, commits or not.`
      : `convo-diff: ${changed} file(s) this conversation changed that are not committed yet (+${added} -${removed}). A file a commit took since this conversation first changed it is compared with that commit; any other with its content before this conversation first changed it. Pass scope "all" for the whole conversation.`,
  ]
  if (committed.length > 0) out.push(`# committed, unchanged since: ${committed.map(file => file.rel).join(', ')}`)
  let size = out.join('\n').length
  for (const file of shown) {
    const lines: string[] = ['']
    if (file.status === 'same' || file.status === 'lost' || file.isBinary) {
      lines.push(`# ${file.rel}: ${file.status === 'same' ? 'no net change' : file.isBinary ? `binary file ${file.status}` : 'no snapshot of its content before'}`)
    } else {
      lines.push(file.status === 'added' ? '--- /dev/null' : `--- a/${file.rel}`)
      lines.push(file.status === 'deleted' ? '+++ /dev/null' : `+++ b/${file.rel}`)
      if (file.isCommitted) lines.push('# against the last commit that took it')
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

// Files a commit took that have not changed since: the pane lists them on one line.
function committedOf(view: ConvoDiffView | null): ConvoDiffFile[] {
  return (view?.files ?? []).filter(file => file.isCommitted && file.status === 'same')
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
function explainPrompt(file: ConvoDiffFile, isAll: boolean): string {
  const path = `\`${file.rel}\``
  const ask =
    file.status === 'added'
      ? `請解釋這個對話新增的 ${path}：它是做什麼的、為什麼需要它、有什麼要注意的。`
      : file.status === 'deleted'
        ? `請解釋這個對話為什麼刪除 ${path}，刪掉之後有什麼要注意的。`
        : `請解釋這個對話對 ${path} 做的改動：改了什麼、為什麼這樣改、有什麼要注意的。`
  const how = isAll ? `path 填 ${file.rel}，scope 填 all` : `path 填 ${file.rel}`
  const since = !isAll && file.isCommitted ? '已經 commit 的部分不用講，只解釋 commit 之後的改動。' : ''
  return `${ask}${since}要看它在這個對話裡的淨改動，可以用 ${TOOL} 工具（${how}）。只要解釋，不要修改任何檔案。`
}

// Sent as the person's own question, since they pressed for it. It starts a turn of its own once the session is
// idle, and the call resolves only then: the toast comes first.
async function askInChat($: EngineInterface, file: ConvoDiffFile, isBusy: boolean, isAll: boolean): Promise<void> {
  $.ui.toast(isBusy ? `Claude 這回合結束後會解釋 ${file.rel}` : `已請 Claude 解釋 ${file.rel}`)
  try {
    await $.prompt.submit({ text: explainPrompt(file, isAll), asUser: true })
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

// Git in the repo's top; with `index`, on that index instead of the repo's own.
async function gitOut($: EngineInterface, top: string, args: readonly string[], index?: string): Promise<string> {
  const init = { cwd: top, timeoutMs: GIT_TIMEOUT_MS }
  const ran = await $.process.run(gitArgv(args), index === undefined ? init : { ...init, env: { GIT_INDEX_FILE: index } })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n')[0] || `git ${args[0]} exited ${ran.exitCode}`)
  if (ran.isStdoutTruncated) throw new Error(`git ${args[0]} said more than its output carries`)
  return ran.stdout
}

// Where this session's snapshots go: an index of its own in the repo's git directory (beside git's, never in the
// work tree); 'off' with no repo, or once they proved too slow.
type Snaps = { top: string; index: string } | 'off'
type Snap = { top: string; tree: string }

let snaps: Snaps | null = null
let snapsTaken = 0
// The latest snapshot, taken as each turn starts and after each command that needed one. Every file this
// conversation changed since is followed already, so one that differs from it and is not followed yet was changed
// by the command just run: one snapshot after a command is enough, and none before it.
let lastSnap: Snap | null = null

async function snapsOf($: EngineInterface): Promise<Snaps> {
  if (snaps !== null) return snaps
  const top = await topOf($)
  const dir = fromMsys((await gitOut($, top, ['rev-parse', '--absolute-git-dir']).catch(() => '')).trim(), top)
  if (dir === '') {
    snaps = 'off'
    return snaps
  }
  const now = await $.clock.now()
  $.clock.after(0, () => void pruneIndexes($, dir, now))
  snaps = { top, index: `${dir}/convo-diff-${Math.random().toString(36).slice(2, 10)}.index` }
  return snaps
}

async function pruneIndexes($: EngineInterface, dir: string, now: number): Promise<void> {
  try {
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !isLeftover(entry.name, entry.mtimeMs, now)) continue
      await removeFile($, `${dir}/${entry.name}`)
    }
  } catch (error) {
    $.ui.log(`pruning old indexes failed: ${reasonOf(error)}`, { to: 'debug' })
  }
}

// The work tree as git sees it, ignored files left out, hashed into this session's index: the tree's id, or null
// where none is taken. Kept between snapshots, the index lets git hash only what changed since the last one; a
// failed snapshot sends the next to a fresh index, in case a killed git left its lock on this one.
async function snap($: EngineInterface): Promise<Snap | null> {
  const where = await snapsOf($)
  if (where === 'off') return null
  const started = await $.clock.now()
  let tree: string
  try {
    await gitOut($, where.top, ['add', '-A'], where.index)
    tree = (await gitOut($, where.top, ['write-tree'], where.index)).trim()
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`git write-tree said ${tree.slice(0, 80)}`)
  } catch (error) {
    snaps = null
    snapsTaken = 0
    throw error
  }
  const took = (await $.clock.now()) - started
  snapsTaken += 1
  if (snapsTaken > 1 && took > SNAP_SLOW_MS) {
    snaps = 'off'
    lastSnap = null
    $.ui.toast(
      `這個 repo 太大，拍一次快照要 ${(took / 1000).toFixed(1)} 秒，這個 session 先不拍了：PowerShell 改的檔案不追蹤，Bash 一次改很多檔案時有些會無法比對`,
    )
    return { top: where.top, tree }
  }
  lastSnap = { top: where.top, tree }
  return lastSnap
}

// The files a command changed between two snapshots. A file's first touch takes its base from the snapshot before:
// git's blob, with the line endings the file has now.
async function trackSnapshots($: EngineInterface, before: Snap, after: Snap, head: string | null): Promise<void> {
  if (after.tree === before.tree) return
  const raw = await gitOut($, before.top, ['diff-tree', '-r', '-z', '--raw', '--no-renames', before.tree, after.tree])
  const track = await ensure($)
  const top = await topOf($)
  let grown = track
  let bases = 0
  for (const file of parseRaw(raw)) {
    const path = `${before.top.replace(/[\\/]+$/, '')}/${file.rel}`
    if (relOf(path, top) === null || isTracked(grown, path)) continue
    if (file.before === null) {
      grown = withBase(grown, top, path, { base: null, isLost: false }, head)
      continue
    }
    bases += 1
    // A blob too large to come back whole is a base lost, as is anything past the first hundred.
    const text =
      bases > SNAP_MAX_BASES ? null : await gitOut($, before.top, ['cat-file', 'blob', file.before]).catch(() => null)
    const seen = text === null ? null : await look($, path)
    const base = text === null ? null : seen?.kind === 'text' ? withEol(text, seen.text) : text
    grown = withBase(grown, top, path, { base, isLost: base === null }, head)
  }
  await keep($, track, grown)
}

// With the keys: on the desktop a pane without them spends a first click on taking them.
function openPane($: EngineInterface): Promise<UiOpenResult> {
  return $.ui.open({ id: PANE, title: TITLE, rows: 30, focus: true })
}

// What each of the pane's buttons does, as last drawn, so the focus ring landing on one can press it too.
const actions = new Map<string, () => unknown>()
let lastPress: { key: string; at: number; isRing: boolean } | null = null
// Whether the pane holds the keys as last drawn, since when, and whether on the desktop.
let keys = { isFocused: false, at: 0, isDesktop: false }

// A press may come twice, by the focus ring and by the click: one of each on one button within the gap is one press.
async function press($: EngineInterface, key: string, isRing = false): Promise<void> {
  const now = await $.clock.now()
  const last = lastPress
  const isEcho = last !== null && last.key === key && last.isRing !== isRing && now - last.at < PRESS_GAP_MS
  lastPress = isEcho ? null : { key, at: now, isRing }
  if (!isEcho) await actions.get(key)?.()
}

async function noteKeys($: EngineInterface, isFocused: boolean, surface: string): Promise<void> {
  if (isFocused !== keys.isFocused) keys = { isFocused, at: await $.clock.now(), isDesktop: surface === 'desktop' }
}

// Tab moves the ring only in a pane that holds the keys, and there a click presses by itself: a move by the person's
// hand into a pane without them is the click that takes them, which presses nothing.
function isTake(held: typeof keys, now: number): boolean {
  return !held.isFocused || (held.isDesktop && now - held.at < TAKE_MS)
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

// Puts a file back as what the pane compares it with: the last commit that took it, else how it was before this
// conversation first changed it. Never further back than a commit: what is committed (or pushed) stays. What it
// replaced is kept for an undo.
async function revertFile($: EngineInterface, key: string, conv: number): Promise<void> {
  await setRevert($, conv, null)
  const found = await fileOf($, key, conv)
  if (found === null) return
  const { base: file, rel } = found
  const seen = await look($, file.path)
  if (seen.kind === 'error') {
    $.ui.toast(`沒辦法還原 ${rel}：${seen.reason}`)
    return
  }
  const top = await topOf($)
  const base = (await againstHead($, top, [file], new Map([[key, seen]]))).get(key)
  if (base === undefined || base.isLost) return
  const before = seen.kind === 'text' ? seen.text : null
  try {
    if (base.base !== null) await $.fs.write(file.path, base.base)
    else if (before !== null) await removeFile($, file.path)
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
  const done = base.isCommitted
    ? base.base === null
      ? `已刪除 ${rel}（上次 commit 裡沒有它）`
      : `已把 ${rel} 還原成上次 commit 的樣子`
    : base.base === null
      ? `已刪除 ${rel}（這個對話新增的檔案）`
      : `已把 ${rel} 還原成這個對話改之前的樣子`
  $.ui.toast(canUndo ? done : `${done}；檔案太大，沒辦法復原`)
  await tellModel(
    $,
    base.isCommitted
      ? base.base === null
        ? `[convo-diff] 我在 diff 面板把 ${rel} 刪掉了：上次 commit 裡沒有它，commit 之後的修改都不在了。`
        : `[convo-diff] 我在 diff 面板把 ${rel} 還原成上次 commit 的內容，commit 之後對它的修改都不在了（已經 commit 的不受影響）。之後要改它請先重新讀取。`
      : base.base === null
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

const DESKTOP = 'ccd_session_mgmt'

// Asks the desktop which session this is and its title; a change reaches the store, where the other conversations
// read it. Nothing outside the desktop.
async function identify($: EngineInterface): Promise<void> {
  let found: typeof who
  try {
    const result = await $.mcp.call(DESKTOP, 'get_session', { session_id: 'self' })
    if (result.isError) return
    const self = record(JSON.parse(result.content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('')))
    found = {
      session: typeof self?.sessionId === 'string' ? self.sessionId : null,
      title: typeof self?.title === 'string' && self.title !== '' ? self.title : null,
    }
  } catch {
    return
  }
  if (found.session === who.session && found.title === who.title) return
  who = found
  await serial(async () => {
    const track = await read($, trackAtom)
    if (track !== null && track.files.length > 0) await persist($, track)
  })
}

// Another conversation that changed a file, as warnings name it.
type Owner = { conv: number; label: string }
type Clash = { rel: string; owners: Owner[] }

function timeOf(at: number): string {
  const date = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function labelOf(kept: Record<string, unknown>, conv: number): string {
  if (typeof kept.session === 'string' && kept.session === who.session) return '這個對話 /clear 之前的部分'
  if (typeof kept.title === 'string' && kept.title !== '') return `另一個對話「${kept.title}」`
  return `另一個對話（${timeOf(conv)} 開始）`
}

// The files the other conversations changed, as the store keeps them, by key: whose they are.
async function othersOf($: EngineInterface, conv: number): Promise<Map<string, Owner[]>> {
  const owners = new Map<string, Owner[]>()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('conv:') || key === storeKey(conv)) continue
    const kept = record(await $.store.get(key))
    const track = record(kept?.track)
    if (kept === null || kept.v !== 1 || track === null || !Array.isArray(track.files)) continue
    const other = Number(track.conv)
    const owner = { conv: other, label: labelOf(kept, other) }
    for (const file of track.files) {
      const fileKey = record(file)?.key
      if (typeof fileKey === 'string') owners.set(fileKey, [...(owners.get(fileKey) ?? []), owner])
    }
  }
  return owners
}

// Whether a file held changes nobody had committed before this conversation first changed it: what it held then
// against the commit's. Null where that cannot be told.
async function isForeign($: EngineInterface, top: string, file: ConvoDiffBase, commit: string | null): Promise<boolean | null> {
  const rel = relOf(file.path, top)
  if (file.isLost || commit === null || rel === null) return null
  let text: string | null = null
  if (commit !== '') {
    const blob = (await blobsIn($, top, commit, [rel])).get(rel) ?? null
    text = blob === null ? null : await blobText($, top, blob)
    if (blob !== null && text === null) return null
  }
  return !sameText(text, file.base)
}

function listOf(items: readonly string[], most: number): string {
  return items.length <= most ? items.join('、') : `${items.slice(0, most).join('、')} 等 ${items.length} 個檔案`
}

function labelsOf(clashes: readonly Clash[]): string {
  return [...new Set(clashes.flatMap(clash => clash.owners.map(owner => owner.label)))].join('、')
}

// One line per owner: `- 另一個對話「X」：a.ts、b.ts`.
function byOwner(clashes: readonly Clash[]): string[] {
  const groups = new Map<string, string[]>()
  for (const clash of clashes) {
    const label = [...new Set(clash.owners.map(owner => owner.label))].join('、')
    const rels = groups.get(label) ?? []
    if (!rels.includes(clash.rel)) rels.push(clash.rel)
    groups.set(label, rels)
  }
  return [...groups].map(([label, rels]) => `- ${label}：${listOf(rels, 10)}`)
}

function relsOf(clashes: readonly Clash[]): string[] {
  return [...new Set(clashes.map(clash => clash.rel))]
}

// What the model reads in place of the command's result.
function refusal(blocked: ReadonlyMap<GitOp, Clash[]>, own: readonly string[]): string {
  const ops = [...blocked.keys()]
  const lines: string[] = []
  for (const op of ops) {
    lines.push(
      `[convo-diff] 已擋下：\`${op.text}\` 會把別的對話還沒 commit 的改動${op.kind === 'stage' ? '一起 commit 進去' : '丟掉'}：`,
      ...byOwner(blocked.get(op) ?? []),
    )
  }
  lines.push('這一整行指令都沒有執行。')
  if (own.length > 0) lines.push(`這個對話自己改、還沒 commit 的檔案：${listOf(own, 30)}（路徑從 repo 的根目錄算）。`)
  if (ops.some(op => op.kind === 'stage')) {
    lines.push(
      '要 commit 這個對話的改動，請只指定這個對話的檔案：`git add -- <檔案>` 再 `git commit -m "<訊息>" -- <檔案>`（commit 後面也接檔案，暫存區裡別的對話的檔案才不會被一起帶進去）。',
    )
  }
  if (ops.some(op => op.kind === 'discard')) {
    lines.push(
      '要還原這個對話的改動，請只指定這個對話的檔案（例如 `git checkout -- <檔案>`）；兩個對話都改過的檔案，請用編輯的方式只改回這個對話的部分（mcp__convo-diff__diff 看得到這個對話改了什麼）。',
    )
  }
  lines.push(`只有在使用者明確要你連別的對話的改動一起處理時，才在指令最後加上 \`${ALLOW}\` 重新執行。`)
  return lines.join('\n')
}

// Before a command runs: one whose git would commit, or throw away, changes another conversation made and has not
// committed is refused; one that commits a file both conversations changed only says so. It fails open: a guard that
// cannot tell lets the command run.
async function guard($: EngineInterface, command: string, shell: Shell): Promise<{ deny?: string; notes: string[] }> {
  try {
    const top = await topOf($)
    if (!isGit) return { notes: [] }
    const inRepoTop = (cwd: string) => keyOf(cwd) === keyOf(top) || relOf(cwd, top) !== null
    const ops = gitOpsOf(command, shell, await $.session.cwd()).filter(op => inRepoTop(op.cwd))
    if (ops.length === 0) return { notes: [] }
    const track = await serial(() => ensure($))
    const others = await othersOf($, track.conv)
    if (others.size === 0) return { notes: [] }

    const dirty = parseStatus(await gitOut($, top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    const mine = new Map(track.files.map(file => [file.key, file]))
    const head = await headOf($)
    const keyIn = (rel: string) => keyOf(`${top.replace(/[\\/]+$/, '')}/${rel}`)
    const blocked = new Map<GitOp, Clash[]>()
    const shared: Clash[] = []
    for (const file of dirty) {
      const owners = others.get(keyIn(file.rel))
      if (owners === undefined) continue
      const own = mine.get(keyIn(file.rel))
      // A file both changed holds the other's changes while what it held before this conversation's first change is
      // not committed.
      if (own !== undefined && (await isForeign($, top, own, head)) === false) continue
      for (const op of ops) {
        if (!takesFile(op, file, top)) continue
        const clash = { rel: file.rel, owners }
        if (own !== undefined && op.kind === 'stage') shared.push(clash)
        else blocked.set(op, [...(blocked.get(op) ?? []), clash])
      }
    }

    const notes =
      shared.length > 0
        ? [['[convo-diff] 注意：下面這些檔案這個對話跟別的對話都改過，別的對話的改動還沒 commit，這次會一起 commit 進去：', ...byOwner(shared)].join('\n')]
        : []
    if (blocked.size === 0) {
      if (shared.length > 0) $.ui.toast(`${listOf(relsOf(shared), 3)} 也有${labelsOf(shared)}還沒 commit 的改動，這次會一起 commit`)
      return { notes }
    }

    const all = [...blocked.values()].flat()
    const [first] = blocked.keys()
    const isDiscard = [...blocked.keys()].some(op => op.kind === 'discard')
    const what = `${labelsOf(all)}還沒 commit 的 ${listOf(relsOf(all), 3)}`
    if (isAllowed(command)) {
      $.ui.toast(`Claude 說是你要求的，convo-diff 放行了 ${first?.text ?? 'git'}：${what} ${isDiscard ? '會被丟掉' : '會一起 commit'}`)
      return { notes: [...notes, ['[convo-diff] 已照使用者的要求放行，這個指令會動到別的對話還沒 commit 的改動：', ...byOwner(all)].join('\n')] }
    }
    $.ui.toast(`convo-diff 擋下了 ${first?.text ?? 'git'}：會把${what} ${isDiscard ? '丟掉' : '一起 commit'}`)
    const own = dirty.filter(file => mine.has(keyIn(file.rel))).map(file => file.rel)
    return { deny: refusal(blocked, own), notes: [] }
  } catch (error) {
    $.ui.log(`guarding a command failed: ${reasonOf(error)}`, { to: 'debug' })
    return { notes: [] }
  }
}

// After a call: the files this conversation just began to change that hold another conversation's changes not
// committed yet. The person gets a toast, the model a note beside the call's result.
async function touchNotes($: EngineInterface, known: ReadonlySet<string> | null): Promise<string[]> {
  if (known === null) return []
  try {
    const track = await read($, trackAtom)
    const fresh = (track?.files ?? []).filter(file => !known.has(file.key))
    if (track === null || fresh.length === 0) return []
    const top = await topOf($)
    if (!isGit) return []
    const others = await othersOf($, track.conv)
    const clashes: Clash[] = []
    for (const file of fresh) {
      const owners = others.get(file.key)
      if (owners === undefined) continue
      const commit = typeof file.head === 'string' ? file.head : await headOf($)
      if ((await isForeign($, top, file, commit)) !== true) continue
      clashes.push({ rel: relOf(file.path, top) ?? normalize(file.path), owners })
    }
    if (clashes.length === 0) return []
    $.ui.toast(`這個對話改到了 ${listOf(relsOf(clashes), 3)}，裡面也有${labelsOf(clashes)}還沒 commit 的改動`)
    return [
      [
        '[convo-diff] 注意：這個對話剛開始改的這些檔案，裡面也有別的對話還沒 commit 的改動（那個對話可能還在改）：',
        ...byOwner(clashes),
        '現在這些檔案混著兩個對話的改動：commit 時會連那些改動一起進去；要還原也不能用 git checkout／restore，只能改回這個對話的部分。',
      ].join('\n'),
    ]
  } catch (error) {
    $.ui.log(`checking for other conversations' changes failed: ${reasonOf(error)}`, { to: 'debug' })
    return []
  }
}

// The keys of the files this conversation follows now: what a call adds to them is what it began to change.
async function knownKeys($: EngineInterface): Promise<Set<string> | null> {
  return serial(async () => new Set((await ensure($)).files.map(file => file.key))).catch(() => null)
}

function withNotes<T extends { context?: readonly string[] }>(ran: T, notes: readonly string[]): T {
  return notes.length === 0 ? ran : ({ ...ran, context: [...(ran.context ?? []), ...notes] } as T)
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
        "The net unified diff of the files in this repo that this conversation changed (Edit, Write, NotebookEdit, Bash and PowerShell commands; what a command's own record leaves out comes from git snapshots of the work tree). By default only what is not committed yet: a file a commit took since this conversation first changed it is compared with that commit, any other with its content before this conversation first changed it. With scope \"all\", the whole conversation, each file against its content before this conversation first changed it, commits or not. Changes made outside this conversation to files it never touched are left out. Use it to review, summarize or commit only this conversation's changes.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Only files whose path contains this text.' },
          scope: {
            type: 'string',
            enum: ['pending', 'all'],
            description: 'pending (the default): what is not committed yet. all: the whole conversation.',
          },
        },
      },
    })
    // The transcript may be long: catching up on it waits for no prompt.
    $.clock.after(0, () => {
      void serial(() => ensure($))
        .then(() => schedule($, 'all'))
        .catch(error => $.ui.log(`start failed: ${reasonOf(error)}`, { to: 'debug' }))
      void identify($).catch(error => $.ui.log(`naming this conversation failed: ${reasonOf(error)}`, { to: 'debug' }))
    })

    return next(e)
  })

  // A /clear starts another conversation: its files start over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await serial(async () => {
        cache.clear()
        lastHead = undefined
        lastSnap = null
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
    // A commit made elsewhere (the person's own terminal) shows by the next turn.
    schedule($, 'all')
    // What the person changed between turns is in this snapshot, so no command takes it for its own. Not awaited: the
    // model thinks meanwhile, and the commands wait behind it in the queue.
    void serial(() => snap($)).catch(error => $.ui.log(`snapshot at the turn's start failed: ${reasonOf(error)}`, { to: 'debug' }))
    // The desktop names a conversation after its first exchange.
    void identify($).catch(error => $.ui.log(`naming this conversation failed: ${reasonOf(error)}`, { to: 'debug' }))

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
      if (isTracked(track, path)) return null
      return { seen: await look($, path), head: await headOf($), known: new Set(track.files.map(file => file.key)) }
    }).catch(() => null)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || record(ran.result)?.staged === true) return ran

    await serial(async () => {
      const track = await ensure($)
      const own = foundIn(e.tool, ran.result)?.found
      const found: Found =
        before?.seen.kind === 'missing'
          ? { base: null, isLost: false }
          : own !== undefined && own.base !== null
            ? own
            : before?.seen.kind === 'text'
              ? { base: before.seen.text, isLost: false }
              : (own ?? { base: null, isLost: true })
      await keep($, track, withBase(track, top, path, found, before?.head ?? null))
    }).catch(error => $.ui.log(`tracking ${path} failed: ${reasonOf(error)}`, { to: 'debug' }))
    schedule($, [keyOf(path)])

    return withNotes(ran, await touchNotes($, before?.known ?? null))
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const guarded = await guard($, e.command, 'bash')
    if (guarded.deny !== undefined) return { deny: guarded.deny }
    const known = await knownKeys($)
    // Before the command: one that changes files and commits them leaves them compared with that commit.
    // A snapshot is taken here only while there is none yet (the mod enabled mid-turn).
    const before = await serial(async () => ({ head: await headOf($), snap: lastSnap ?? (await snap($).catch(() => null)) })).catch(
      () => null,
    )
    const head = before?.head ?? null
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || ran.isReadOnly === true) return ran

    const edits = bashEditsOf(ran.result)
    if (edits.files.length > 0 || edits.isPartial) {
      await serial(async () => {
        const track = await ensure($)
        const top = await topOf($)
        const cwd = await $.session.cwd()
        let grown = track
        for (const edit of edits.files) {
          const path = absolute(edit.path, cwd)
          if (relOf(path, top) === null || isTracked(grown, path)) continue
          if (edit.isCreated) {
            grown = withBase(grown, top, path, { base: null, isLost: false }, head)
            continue
          }
          const seen: Seen = edit.isDeleted ? { kind: 'missing' } : await look($, path)
          const after = seen.kind === 'text' ? seen.text : seen.kind === 'missing' ? '' : null
          const base = after === null || edit.hunks.length === 0 ? null : unapply(after, edit.hunks)
          grown = withBase(grown, top, path, { base, isLost: base === null }, head)
        }
        await keep($, track, grown)
        if (!edits.isPartial) return

        // The rest the snapshot before tells, against one after; what it cannot (no repo, an ignored file) is lost.
        const first = before?.snap ?? null
        const after = first === null ? null : await snap($).catch(error => {
          $.ui.log(`snapshot after a Bash command failed: ${reasonOf(error)}`, { to: 'debug' })
          return null
        })
        if (first !== null && after !== null) await trackSnapshots($, first, after, head)
        const now = await ensure($)
        let rest = now
        for (const changed of edits.more) rest = withBase(rest, top, absolute(changed, cwd), { base: null, isLost: true }, head)
        await keep($, now, rest)
      }).catch(error => $.ui.log(`tracking a Bash command failed: ${reasonOf(error)}`, { to: 'debug' }))
    }
    // A command may also have changed files this conversation already follows (a formatter, a revert).
    schedule($, 'all')

    return withNotes(ran, [...guarded.notes, ...(await touchNotes($, known))])
  })

  // PowerShell's record names no files: the latest snapshot and one after the command tell which changed.
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const guarded = await guard($, e.command, 'powershell')
    if (guarded.deny !== undefined) return { deny: guarded.deny }
    const known = await knownKeys($)
    const before = await serial(async () => ({ snap: lastSnap ?? (await snap($)), head: await headOf($) })).catch(error => {
      $.ui.log(`snapshot before a PowerShell command failed: ${reasonOf(error)}`, { to: 'debug' })
      return null
    })
    const ran = await next(e)
    // Refused, or read-only as the engine judged it. One that failed may still have changed files.
    if (ran.deny !== undefined || ran.isReadOnly === true) return ran

    if (before !== null && before.snap !== null) {
      const { snap: first, head } = before
      await serial(async () => {
        const after = await snap($)
        if (after !== null) await trackSnapshots($, first, after, head)
      }).catch(error => $.ui.log(`tracking a PowerShell command failed: ${reasonOf(error)}`, { to: 'debug' }))
    }
    schedule($, 'all')

    return withNotes(ran, [...guarded.notes, ...(await touchNotes($, known))])
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    await serial(async () => {
      await ensure($)
      await refresh($, 'all')
    })
    const view = await read($, viewAtom)
    const filter = typeof e.path === 'string' ? e.path.trim() : ''

    return { result: patchText(view, filter, e.scope === 'all') }
  })

  on('command.run', { command: COMMAND }, async $ => {
    await serial(async () => {
      await ensure($)
      await refresh($, 'all')
    })
    const view = await read($, viewAtom)
    const { changed, added, removed } = totals(view?.files ?? [])
    const committed = committedOf(view).length
    const opened = await openPane($)
    const head =
      changed > 0
        ? `這個對話改了 ${changed} 個檔案（+${added} -${removed}）${committed > 0 ? `，不算已經 commit 的 ${committed} 個` : ''}`
        : committed > 0
          ? `這個對話改的 ${committed} 個檔案都 commit 了`
          : '這個對話還沒有改任何檔案'

    return { text: opened.isPlaced ? `${head}，diff 在面板裡。` : `${head}；面板還沒顯示：${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    await noteKeys($, e.props.isFocused === true, e.surface)
    const view = await read($, viewAtom)
    const open = await read($, openAtom)
    const reverts = await read($, revertAtom)

    if (view === null || view.all.length === 0) {
      return (
        <Box flexDirection="column">
          <Text>這個對話還沒有改任何檔案。</Text>
          <Text dimColor>
            之後用 Edit、Write、NotebookEdit 或 Bash 改到 repo 裡的檔案會列在這裡，每個檔案都跟它在這個對話第一次被改之前的內容比；commit 過的就改跟那次 commit 比。
          </Text>
        </Box>
      )
    }

    const conv = view.conv
    const isAll = open !== null && open.conv === conv && open.isAll === true
    const committed = isAll ? [] : committedOf(view)
    const files = (isAll ? view.all : view.files).filter(file => !committed.includes(file))
    const hasBody = (file: ConvoDiffFile) => file.chunks.length > 0
    const choiceOf = (file: ConvoDiffFile) => (open !== null && open.conv === conv ? open.keys[file.key] : undefined)
    const isOpenOf = (file: ConvoDiffFile) => hasBody(file) && choiceOf(file) !== false
    const anyOpen = files.some(isOpenOf)
    const setOpen = (change: (held: ConvoDiffOpen) => ConvoDiffOpen) =>
      update($, openAtom, held => change(held !== null && held.conv === conv ? held : { conv, keys: {} }))
    const toggle = (file: ConvoDiffFile) => setOpen(held => ({ ...held, keys: { ...held.keys, [file.key]: held.keys[file.key] === false } }))
    const setAll = (isOpen: boolean) => setOpen(held => ({ ...held, keys: Object.fromEntries(files.map(file => [file.key, isOpen])) }))
    const { changed, added, removed } = totals(files)
    const pressOf = (key: string, action: () => unknown) => {
      actions.set(key, action)
      return () => void press($, key)
    }
    const confirming = reverts !== null && reverts.conv === conv ? reverts.confirm : null
    const undos = reverts !== null && reverts.conv === conv ? reverts.undo : {}
    const title = isAll
      ? `整段對話改了 ${changed} 個檔案`
      : changed > 0
        ? `這個對話改了 ${changed} 個檔案`
        : committed.length > 0
          ? '這個對話的改動都 commit 了'
          : '這個對話改過的檔案現在都跟原本一樣'

    let budget = RENDER_BUDGET
    // A long diff in pieces, the file's name above each after the first: a window of the pane's height always holds
    // one, a line that wraps aside.
    const pieceRows = Math.max(10, (e.props.scroll?.bodyRows ?? 40) - 6)
    const rows = files.slice(0, MAX_FILES_DRAWN).map((file, index) => {
      const isOpen = isOpenOf(file)
      const cost = file.chunks.reduce((sum, chunk) => sum + JSON.stringify(chunk).length, 0)
      const fits = cost <= budget
      if (isOpen && fits) budget -= cost
      const arrow = hasBody(file) ? (isOpen ? '▾' : '▸') : '·'
      const isConfirming = !isAll && confirming === file.key
      const question =
        file.status === 'added'
          ? file.isCommitted
            ? `刪除 ${file.rel}？上次 commit 裡沒有它。`
            : `刪除 ${file.rel}？它是這個對話新增的檔案。`
          : file.isCommitted
            ? `把 ${file.rel} 還原成上次 commit 的內容？已經 commit 的改動不受影響。`
            : `把 ${file.rel} 還原成這個對話改之前的內容？`

      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button
              plain
              key={`f${index}`}
              label={`${arrow} ${file.rel}`}
              dimColor={file.status === 'same' || file.status === 'lost'}
              onPress={pressOf(`f${index}`, () => toggle(file))}
            />
            <Text color={STATUS_COLOR[file.status]}>{STATUS_LABEL[file.status]}</Text>
            {file.added > 0 && <Text color="success">{`+${file.added}`}</Text>}
            {file.removed > 0 && <Text color="error">{`-${file.removed}`}</Text>}
            {!isAll && file.isCommitted && file.status !== 'same' && <Text dimColor>（跟上次 commit 比）</Text>}
            {canExplain(file) && (
              <Button
                key={`x${index}`}
                label="解釋"
                onPress={pressOf(`x${index}`, () => {
                  // Off the press: the question is answered in the conversation, not here.
                  $.clock.after(0, () => void askInChat($, file, running.size > 0, isAll))
                })}
              />
            )}
            {!isAll && canRevert(file) && !isConfirming && (
              <Button key={`r${index}`} label="還原" onPress={pressOf(`r${index}`, () => setRevert($, conv, file.key))} />
            )}
            {undos[file.key] !== undefined && (
              <Button key={`u${index}`} label="復原" onPress={pressOf(`u${index}`, () => undoRevert($, file.key, conv))} />
            )}
          </Box>
          {isConfirming && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              <Text color="warning">{question}</Text>
              <Button
                key={`rc${index}`}
                variant="primary"
                label={file.status === 'added' ? '確定刪除' : '確定還原'}
                onPress={pressOf(`rc${index}`, () => revertFile($, file.key, conv))}
              />
              <Button key={`rn${index}`} label="取消" onPress={pressOf(`rn${index}`, () => setRevert($, conv, null))} />
            </Box>
          )}
          {file.note !== null && (isOpen || !hasBody(file)) && <Text dimColor>{file.note}</Text>}
          {isOpen &&
            fits &&
            piecesOf(file.chunks, pieceRows).map((piece, at) =>
              at === 0 ? (
                <Code source={piece} format="diff" path={file.path} />
              ) : (
                <Box flexDirection="column">
                  <Text dimColor wrap="truncate-end">{`${arrow} ${file.rel}（續）`}</Text>
                  <Code source={piece} format="diff" path={file.path} />
                </Box>
              ),
            )}
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
          <Text bold>{title}</Text>
          {added > 0 && <Text color="success">{`+${added}`}</Text>}
          {removed > 0 && <Text color="error">{`-${removed}`}</Text>}
          <Button
            key="scope"
            label={isAll ? '只看還沒 commit 的' : '看整段對話'}
            onPress={pressOf('scope', () => setOpen(held => ({ ...held, isAll: !isAll })))}
          />
          <Button key="refresh" label="重新整理" onPress={pressOf('refresh', () => serial(() => refresh($, 'all')))} />
          <Button key="fold" label={anyOpen ? '全部收合' : '全部展開'} onPress={pressOf('fold', () => setAll(!anyOpen))} />
          <Button key="close" role="dismiss" label="關閉" onPress={pressOf('close', () => $.ui.close({ id: PANE }))} />
        </Box>
        {isAll && (
          <Text dimColor>整段對話：每個檔案跟這個對話第一次改它之前比，commit 過的也算。這裡只能看，要還原請切回「只看還沒 commit 的」。</Text>
        )}
        {committed.length > 0 && (
          <Text dimColor wrap="truncate-end">
            {`已經 commit、之後沒再改（${committed.length}）：${committed.map(file => file.rel).join('、')}`}
          </Text>
        )}
        {rows}
        {files.length > MAX_FILES_DRAWN && <Text dimColor>{`… 還有 ${files.length - MAX_FILES_DRAWN} 個檔案沒列出來`}</Text>}
      </Box>
    )
  })

  // While the prompt holds the keys, a click on the desktop's pane only takes them and moves its focus ring onto a
  // button, and the press waits for a second click: that ring move presses it. Once the pane holds the keys, a move is
  // Tab, which must only walk, or a click that presses by itself.
  on('ui.focus', { component: 'Pane' }, async ($, e, next) => {
    // As drawn before this move: the drawing after it has the pane holding the keys.
    const held = keys
    const now = await $.clock.now()
    const result = await next(e)
    const element = e.element
    if (
      result.deny === undefined &&
      e.plugin === PLUGIN &&
      e.requestId === PANE &&
      e.origin.kind === 'person' &&
      element !== undefined &&
      isTake(held, now)
    ) {
      $.clock.after(0, () => void press($, element, true).catch(() => undefined))
    }

    return result
  })

  // On the desktop, a small button above the prompt opens the pane, so there is no /convo-diff to type. It sits to the
  // right of what other plugins draw in the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    if (e.surface !== 'desktop' || e.props.hasSurvey) return beneath
    const view = await read($, viewAtom)
    const { changed } = totals(view?.files ?? [])
    // Everything committed: the button stays, to reach the whole conversation, and says so.
    const isCommitted = changed === 0 && committedOf(view).length > 0
    if (changed === 0 && !isCommitted) return beneath

    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="flex-start" columnGap={2}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {beneath}
        </Box>
        <Button key={OPEN} label={`${TITLE}（${isCommitted ? '都 commit 了' : changed}）`} onPress={() => void openPane($)} />
      </Box>
    )
  })

  // While the prompt holds the keys, a click on the desktop band only moves its focus ring onto the button, and the
  // press waits for a second click. Opening the pane harms nothing, so the ring landing there by the person's hand
  // opens it too; a Tab onto it does the same, since the two cannot be told apart.
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && e.plugin === PLUGIN && e.element === OPEN && e.origin.kind === 'person') {
      $.clock.after(0, () => void openPane($).catch(() => undefined))
    }

    return result
  })
}
