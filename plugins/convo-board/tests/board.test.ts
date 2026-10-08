import { expect, test } from 'claude-code/testing'

import type { ConvoBoardEntry, ConvoBoardSession } from '../types'
import { asksBack, buildView, describeAsk, describeTool, firstLine, folderOf, safeLink, span } from '../hooks/board'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function entry(id: string, fields: Partial<ConvoBoardEntry> = {}): ConvoBoardEntry {
  return {
    v: 1,
    id,
    title: `line ${id}`,
    cwd: `D:\\程式\\${id}`,
    link: `claude://claude.ai/epitaxy/${id}`,
    isDesktop: true,
    phase: 'idle',
    since: NOW - MINUTE,
    turnAt: null,
    ask: null,
    doing: null,
    isBusy: false,
    answer: null,
    outcome: null,
    isSeen: true,
    beat: NOW,
    ...fields,
  }
}

function session(id: string, fields: Partial<ConvoBoardSession> = {}): ConvoBoardSession {
  return { id, title: `title ${id}`, cwd: `D:\\程式\\${id}`, link: `claude://claude.ai/epitaxy/${id}`, isRunning: false, ...fields }
}

test('a tool call or a dialog reads as a few words', () => {
  expect(describeTool('Bash', { command: 'npm test\nsecond line' })).toBe('執行 npm test')
  expect(describeTool('PowerShell', { command: 'Get-ChildItem' })).toBe('執行 Get-ChildItem')
  expect(describeTool('Edit', { file_path: 'D:\\proj\\src\\App.tsx' })).toBe('編輯 App.tsx')
  expect(describeTool('Write', { file_path: '/home/u/notes.md' })).toBe('編輯 notes.md')
  expect(describeTool('Read', { file_path: 'a/b/c.md' })).toBe('讀 c.md')
  expect(describeTool('Grep', { pattern: 'TODO' })).toBe('搜尋「TODO」')
  expect(describeTool('Agent', { description: 'Find the callers' })).toBe('交給子代理：Find the callers')
  expect(describeTool('WebFetch', { url: 'https://example.com/a?b=1' })).toBe('讀網頁 example.com')
  expect(describeTool('mcp__github__create_pull_request', {})).toBe('用 github 的 create_pull_request')
  expect(describeTool('Something', {})).toBe('用 Something')

  expect(describeAsk('Bash', { command: 'git push origin main' })).toBe('要你批准：執行 git push origin main')
  expect(describeAsk('Edit', { file_path: 'D:\\a\\b.ts' })).toBe('要你批准：編輯 b.ts')
  expect(describeAsk('AskUserQuestion', { questions: [{ question: '要用哪個資料庫？', options: [] }] })).toBe('問你：要用哪個資料庫？')
  expect(describeAsk('AskUserQuestion', {})).toBe('問你問題')
  expect(describeAsk('ExitPlanMode', { plan: '...' })).toBe('計畫等你批准')
})

test('folders, first lines, questions back, spans of time and links', () => {
  expect(folderOf('D:\\程式\\Stock')).toBe('Stock')
  expect(folderOf('D:\\程式\\claude-mods\\.claude\\worktrees\\fix-x')).toBe('claude-mods')
  expect(folderOf('/home/u/proj/')).toBe('proj')

  expect(firstLine('\n\n## 回測完成\n細節')).toBe('回測完成')
  expect(firstLine('**勝率** 58%，`ok`')).toBe('勝率 58%，ok')
  expect(firstLine('- 第一點\n- 第二點')).toBe('第一點')
  expect(firstLine('snake_case_name')).toBe('snake_case_name')
  expect(firstLine('一二三四五六七八九十', 5)).toBe('一二三四…')

  expect(asksBack('做好了。\n\n要我順便 commit 嗎？')).toBe(true)
  expect(asksBack('Done.\n\nShall I push it?**')).toBe(true)
  expect(asksBack('做好了。')).toBe(false)
  expect(asksBack('')).toBe(false)

  expect(span(30_000)).toBe('不到 1 分鐘')
  expect(span(12 * MINUTE)).toBe('12 分鐘')
  expect(span(3 * HOUR + 5 * MINUTE)).toBe('3 小時')
  expect(span(50 * HOUR)).toBe('2 天')

  expect(safeLink('claude://claude.ai/epitaxy/local_1a2b')).toBe('claude://claude.ai/epitaxy/local_1a2b')
  expect(safeLink('claude://claude.ai/epitaxy/x & calc')).toBe(null)
  expect(safeLink('https://claude.ai/epitaxy/local_1')).toBe(null)
  expect(safeLink(undefined)).toBe(null)
})

test('the board sorts the other conversations into what waits, what ended unseen and what runs', () => {
  const entries = [
    entry('me', { phase: 'running', turnAt: NOW - MINUTE }),
    entry('a', { phase: 'waiting', since: NOW - 4 * MINUTE, turnAt: NOW - 9 * MINUTE, doing: '要你批准：執行 git push', ask: '推上去' }),
    entry('b', { phase: 'done', since: NOW - 6 * MINUTE, answer: '## 回測完成\n勝率 58%\n\n要我調整停損嗎？', outcome: 'answered', isSeen: false }),
    entry('c', { phase: 'done', since: NOW - 2 * MINUTE, answer: 'old news', outcome: 'answered', isSeen: true }),
    entry('d', { phase: 'running', since: NOW - 12 * MINUTE, turnAt: NOW - 12 * MINUTE, doing: '執行 npm test', isBusy: true, ask: '跑測試' }),
    entry('e', { phase: 'running', since: NOW - 3 * MINUTE, turnAt: NOW - 3 * MINUTE, doing: '編輯 a.ts', isBusy: false }),
    entry('f'),
    entry('g', { phase: 'done', since: NOW - 30_000, answer: 'API Error: overloaded', outcome: 'failed', isSeen: false }),
  ]
  const sessions = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => session(id)).concat(session('h', { isRunning: true }), session('me', { isRunning: true }))
  const { rows } = buildView(entries, sessions, 'me', NOW)

  expect(rows.map(row => `${row.section}:${row.id}`)).toEqual([
    'waiting:a',
    'unseen:g',
    'unseen:b',
    'running:d',
    'running:e',
    'running:h',
  ])
  const by = (id: string) => rows.find(row => row.id === id)
  expect(by('a')).toMatchObject({ title: 'title a', folder: 'a', detail: '要你批准：執行 git push', time: '等了 4 分鐘', ask: '推上去' })
  expect(by('b')).toMatchObject({ detail: '回測完成', time: '6 分鐘前', asksBack: true, isError: false })
  expect(by('b')?.answer).toContain('勝率 58%')
  expect(by('g')).toMatchObject({ detail: '出錯停下來了：API Error: overloaded', time: '剛剛', isError: true, asksBack: false })
  expect(by('d')).toMatchObject({ detail: '正在：執行 npm test', time: '跑了 12 分鐘', link: 'claude://claude.ai/epitaxy/d' })
  expect(by('e')).toMatchObject({ detail: '剛才：編輯 a.ts', time: '跑了 3 分鐘' })
  expect(by('h')).toMatchObject({ detail: '這個對話還沒載入看板，看不到細節', title: 'title h' })
})

test('one the desktop no longer lists is gone, one stopped mid-turn ended, and a terminal one stays', () => {
  const entries = [
    entry('gone', { phase: 'done', answer: 'x', outcome: 'answered', isSeen: false }),
    entry('cut', { phase: 'running', turnAt: NOW - 10 * MINUTE, beat: NOW - 2 * MINUTE, doing: '執行 make' }),
    entry('busy', { phase: 'running', turnAt: NOW - 10 * MINUTE, beat: NOW - 2 * MINUTE, doing: '執行 make' }),
    entry('cli-1', { phase: 'waiting', isDesktop: false, link: null, cwd: '/home/u/proj', title: null, ask: '修 bug', doing: '問你：哪個版本？' }),
  ]
  const sessions = [session('cut'), session('busy', { isRunning: true })]
  const { rows } = buildView(entries, sessions, 'me', NOW)
  expect(rows.map(row => `${row.section}:${row.id}`)).toEqual(['waiting:cli-1', 'unseen:cut', 'running:busy'])
  expect(rows[0]).toMatchObject({ title: '修 bug', folder: 'proj', link: null, isDesktop: false })
  expect(rows[1]).toMatchObject({ detail: '跑到一半停掉了（對話被關掉）', time: '2 分鐘前', isError: true })

  // Where the desktop's list could not be read, nothing is dropped for missing from it.
  const unread = buildView(entries, null, 'me', NOW)
  expect(unread.rows.map(row => row.id)).toContain('gone')
})
