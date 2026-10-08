import type { ConvoBoardEntry, ConvoBoardRow, ConvoBoardSection, ConvoBoardSession, ConvoBoardView } from '../types'

// No sign of life for this long: the conversation's process has stopped.
export const STALE_MS = 90_000

const MINUTE = 60_000
const ORDER: readonly ConvoBoardSection[] = ['waiting', 'unseen', 'running']

// A link the opener may be handed: the desktop's claude:// spelling, nothing a shell would read as more than a word.
export function safeLink(link: unknown): string | null {
  return typeof link === 'string' && /^claude:\/\/[A-Za-z0-9._~/-]+$/.test(link) ? link : null
}

// The folder a conversation works in; a worktree's is its repository's.
export function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(part => part !== '')
  const tree = parts.findIndex((part, index) => part === '.claude' && parts[index + 1] === 'worktrees')
  return (tree > 0 ? parts[tree - 1] : parts.at(-1)) ?? cwd
}

export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// The first line with words in it, without markdown's marks.
export function firstLine(text: string, max = 80): string {
  const line =
    text
      .split('\n')
      .map(part => part.replace(/^\s*(?:#+|[-*+>]|\d+\.)\s+/, '').replace(/\*\*|__|`/g, '').trim())
      .find(part => part !== '') ?? ''
  return cut(line, max)
}

// The answer's last words ask the person something.
export function asksBack(answer: string): boolean {
  const last = answer
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .at(-1)
  return last !== undefined && /[?？][)）」』*_`\s]*$/.test(last)
}

// A stretch of time in words.
export function span(ms: number): string {
  if (ms < MINUTE) return '不到 1 分鐘'
  const minutes = Math.floor(ms / MINUTE)
  if (minutes < 60) return `${minutes} 分鐘`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小時`
  return `${Math.floor(hours / 24)} 天`
}

function ago(ms: number): string {
  return ms < MINUTE ? '剛剛' : `${span(ms)}前`
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nameOf(path: unknown): string {
  return textField(path).split(/[\\/]/).filter(part => part !== '').at(-1) ?? ''
}

// A command without the step into its folder that leads it: the folder is on the board already.
function withoutCd(command: string): string {
  return command.replace(/^\s*(?:cd|Set-Location)\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)\s*/i, '')
}

function hostOf(url: unknown): string {
  try {
    return new URL(textField(url)).host
  } catch {
    return cut(textField(url), 40)
  }
}

// What a tool call does, in a few words.
export function describeTool(tool: string, input: Readonly<Record<string, unknown>>): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `執行 ${firstLine(withoutCd(textField(input.command)), 48)}`.trim()
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `編輯 ${nameOf(input.file_path)}`.trim()
    case 'NotebookEdit':
      return `編輯 ${nameOf(input.notebook_path)}`.trim()
    case 'Read':
      return `讀 ${nameOf(input.file_path)}`.trim()
    case 'Grep':
      return `搜尋「${cut(textField(input.pattern), 30)}」`
    case 'Glob':
      return `找檔案 ${cut(textField(input.pattern), 30)}`.trim()
    case 'Agent':
    case 'Task':
      return `交給子代理：${cut(textField(input.description), 40)}`
    case 'WebSearch':
      return `查網路：${cut(textField(input.query), 40)}`
    case 'WebFetch':
      return `讀網頁 ${hostOf(input.url)}`.trim()
    case 'TodoWrite':
      return '更新待辦清單'
    case 'AskUserQuestion':
      return '問你問題'
    case 'Skill':
      return `用技能 ${textField(input.skill)}`.trim()
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      return mcp === null ? `用 ${tool}` : `用 ${mcp[1]} 的 ${mcp[2]}`
    }
  }
}

// What a dialog in front of the person asks of them.
export function describeAsk(tool: string, input: unknown): string {
  const fields = input !== null && typeof input === 'object' ? (input as Readonly<Record<string, unknown>>) : {}
  if (tool === 'AskUserQuestion') {
    const first: unknown = Array.isArray(fields.questions) ? fields.questions[0] : undefined
    const question = first !== null && typeof first === 'object' ? (first as { question?: unknown }).question : undefined
    const words = firstLine(textField(question), 60)
    return words === '' ? '問你問題' : `問你：${words}`
  }
  if (tool === 'ExitPlanMode') return '計畫等你批准'
  return `要你批准：${describeTool(tool, fields)}`
}

type Placed = ConvoBoardRow & { at: number }

function rowOf(entry: ConvoBoardEntry, listed: ConvoBoardSession | undefined, now: number): Placed | null {
  // Silent too long in the middle of a turn: its process stopped (the app closed, the desktop let it go).
  const isCut =
    (entry.phase === 'running' || entry.phase === 'waiting') && now - entry.beat > STALE_MS && listed?.isRunning !== true
  const base = {
    id: entry.id,
    title: listed?.title || entry.title || firstLine(entry.ask ?? '', 30) || '（未命名）',
    folder: folderOf(listed?.cwd || entry.cwd),
    link: listed?.link ?? entry.link,
    isDesktop: entry.isDesktop,
    ask: entry.ask,
    answer: null,
    isError: false,
    asksBack: false,
  }
  if (isCut) {
    return { ...base, section: 'unseen', detail: '跑到一半停掉了（對話被關掉）', time: ago(now - entry.beat), isError: true, at: entry.beat }
  }
  if (entry.phase === 'waiting') {
    return { ...base, section: 'waiting', detail: entry.doing ?? '等你回應', time: `等了 ${span(now - entry.since)}`, at: entry.since }
  }
  if (entry.phase === 'running') {
    const turnAt = entry.turnAt ?? entry.since
    const detail = entry.doing === null ? '想一想中' : `${entry.isBusy ? '正在' : '剛才'}：${entry.doing}`
    return { ...base, section: 'running', detail, time: `跑了 ${span(now - turnAt)}`, at: turnAt }
  }
  if (entry.phase !== 'done' || entry.isSeen) return null

  const { answer, outcome } = entry
  const detail =
    outcome === 'cut'
      ? '跑到一半停掉了（對話被關掉）'
      : outcome === 'failed'
        ? `出錯停下來了${answer === null ? '' : `：${firstLine(answer, 60)}`}`
        : answer === null
          ? '跑完了'
          : firstLine(answer)
  return {
    ...base,
    section: 'unseen',
    detail,
    time: ago(now - entry.since),
    answer,
    isError: outcome === 'failed' || outcome === 'cut',
    asksBack: outcome === 'answered' && answer !== null && asksBack(answer),
    at: entry.since,
  }
}

// The board: every other conversation that waits on the person, ended unseen, or runs, by what the desktop lists.
// `sessions` null: the desktop's list could not be read, so nothing is dropped for being missing from it.
export function buildView(
  entries: readonly ConvoBoardEntry[],
  sessions: readonly ConvoBoardSession[] | null,
  meId: string,
  now: number,
): ConvoBoardView {
  const listed = sessions === null ? null : new Map(sessions.map(session => [session.id, session]))
  const reported = new Set<string>()
  const rows: Placed[] = []
  for (const entry of entries) {
    if (entry.id === meId || reported.has(entry.id)) continue
    reported.add(entry.id)
    const session = listed?.get(entry.id)
    // The desktop lists every conversation it keeps: one it no longer lists was archived or deleted.
    if (listed !== null && entry.isDesktop && session === undefined) continue
    const row = rowOf(entry, session, now)
    if (row !== null) rows.push(row)
  }
  // Running with no line of its own: a conversation opened before the board was installed.
  for (const session of sessions ?? []) {
    if (session.id === meId || reported.has(session.id) || !session.isRunning) continue
    rows.push({
      id: session.id,
      section: 'running',
      title: session.title || '（未命名）',
      folder: folderOf(session.cwd),
      link: session.link,
      isDesktop: true,
      detail: '這個對話還沒載入看板，看不到細節',
      ask: null,
      time: '',
      answer: null,
      isError: false,
      asksBack: false,
      at: now,
    })
  }
  // Waiting and running in the order they began, so rows stay put; what ended unseen, the newest first.
  const sorted = ORDER.flatMap(section =>
    rows
      .filter(row => row.section === section)
      .sort((a, b) => (section === 'unseen' ? b.at - a.at : a.at - b.at) || a.id.localeCompare(b.id)),
  )
  return { rows: sorted.map(({ at: _at, ...row }) => row) }
}
