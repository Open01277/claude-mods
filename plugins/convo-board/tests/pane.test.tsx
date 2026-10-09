import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import type { ConvoBoardEntry } from '../types'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const MINUTE = 60_000
const ME = 'local_me'
const PANE = 'convo-board'
const CWD = 'D:\\程式\\claude-mods'
const START = { cwd: CWD, surface: 'desktop', isInteractive: true } as never
const SURFACES = ['terminal', 'desktop'] as const

const PANE_PROPS = {
  title: '看板',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const link = (id: string) => `claude://claude.ai/epitaxy/${id}`

// Every string a drawing shows: text children, Button labels and Markdown text.
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const element = node as RenderElement & { children?: unknown[]; props?: Record<string, unknown> }
  const own = [element.props?.label, element.props?.text].filter((value): value is string => typeof value === 'string')
  return [...own, ...(element.children ?? []).map(textOf)].join(' ')
}

function entry(id: string, fields: Partial<ConvoBoardEntry> = {}): ConvoBoardEntry {
  return {
    v: 1,
    id,
    title: null,
    cwd: `D:\\程式\\${id}`,
    link: link(id),
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

type World = {
  // What draws the conversation now: empty while nobody has it on screen.
  surfaces: string[]
  // A desktop runs the session; else its tools are not there, as in a terminal.
  isDesktop: boolean
  sessions: Record<string, unknown>[]
  panes: string[]
  opened: string[]
  runs: string[][]
  toasts: string[]
  // The plugin's store, as JSON keeps it.
  kept: Map<string, unknown>
  // Lets the call waiting on the person's approval go on.
  release: (() => void) | null
}

// The engine and the desktop beneath the plugin.
function world(on: On, engine: Engine, kept: Readonly<Record<string, unknown>> = {}): World {
  const w: World = {
    surfaces: ['desktop'],
    isDesktop: true,
    sessions: [],
    panes: [],
    opened: [],
    runs: [],
    toasts: [],
    kept: new Map(Object.entries(kept)),
    release: null,
  }
  const answer = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } }) as never
  on('store.get', ($, e) => ({ value: w.kept.get((e as { key: string }).key) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    w.kept.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    w.kept.delete((e as { key: string }).key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...w.kept.keys()] }) as never)
  on('session.start', () => ({ cwd: CWD }) as never)
  on('session.end', () => ({ sessionId: 'cli-1' }) as never)
  on('session.attach', ($, e) => ({ clientId: (e as { clientId: string }).clientId }) as never)
  on('session.detach', ($, e) => ({ clientId: (e as { clientId: string }).clientId }) as never)
  on('turn.start', ($, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.surfaces', () => ({ value: w.surfaces }) as never)
  on('session.id', () => ({ value: 'cli-1' }) as never)
  on('session.cwd', () => ({ value: CWD }) as never)
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('mcp.call', ($, e) => {
    const { server, tool } = e as { server: string; tool: string }
    if (!w.isDesktop || server !== 'ccd_session_mgmt') {
      return { value: { content: [{ type: 'text', text: `No MCP server named ${server}` }], isError: true } } as never
    }
    if (tool === 'get_session') return answer({ sessionId: ME, title: '儀表板設計', cwd: CWD, link: link(ME), isRunning: true })
    if (tool === 'list_sessions') return answer(w.sessions)
    throw new Error(`no tool ${tool}`)
  })
  on('ui.open', ($, e) => {
    const { id } = e as { id: string }
    w.opened.push(id)
    if (!w.panes.includes(id)) w.panes.push(id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: w.panes.map(id => ({ id, title: '看板', isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.close', ($, e) => {
    w.panes = w.panes.filter(id => id !== (e as { id: string }).id)
    return { value: undefined } as never
  })
  on('ui.focus', () => ({}) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('process.run', ($, e) => {
    w.runs.push([...(e as { argv: readonly string[] }).argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  // The engine's decider: every Bash call is put to it, as the auto mode's classifier and the person both are.
  on('tool.check', () => ({ decision: 'ask', reason: 'needs approval' }) as never)
  // No settings hook beneath: the dialog is shown.
  on('classic.PermissionRequest', () => ({}) as never)
  on('tool.call', async ($, e) => {
    const call = e as { tool: string; command?: string; tool_use_id?: string }
    if (call.tool === 'Bash' && call.command?.startsWith('git push') === true) {
      await engine.tool.check({ tool: 'Bash', input: { command: call.command }, tool_use_id: call.tool_use_id } as never)
      await engine.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: call.command } } as never)
      await new Promise<void>(resolve => {
        w.release = resolve
      })
    }
    return { result: {} } as never
  })
  return w
}

function mine(w: World): ConvoBoardEntry {
  return w.kept.get(`conv:${ME}`) as ConvoBoardEntry
}

async function drawn($: Engine, surface: (typeof SURFACES)[number] = 'desktop'): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'convo-board', surface, component: 'Pane', props: PANE_PROPS as never, requestId: PANE })
  const text = textOf(await ui.drawn())
  await ui.unmount()
  return text
}

test('a conversation tells the boards it runs, waits on the person, and ended while nobody looked', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { OS: 'Windows_NT' })
  const w = world(on, $)
  await $.session.start(START)
  await clock.settle()
  // On screen in the desktop: the board opens beside it by itself.
  expect(w.opened).toEqual([PANE])
  expect(mine(w)).toMatchObject({ id: ME, title: '儀表板設計', link: link(ME), isDesktop: true, phase: 'idle' })

  await $.turn.start({ text: '幫我推上去\n然後開 PR', turnId: 't1' } as never)
  expect(mine(w)).toMatchObject({ phase: 'running', ask: '幫我推上去', turnAt: NOW })

  // A call the auto mode decides is put to the decider too, and raises no dialog: still running.
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b0' } as never)
  await clock.advance(1000)
  expect(mine(w)).toMatchObject({ phase: 'running', doing: '執行 npm test', isBusy: false })

  // One the person has to approve: waiting, saying what for, until they answer.
  await clock.advance(2 * MINUTE)
  const call = $.tool.call({ tool: 'Bash', command: 'git push origin main', tool_use_id: 'b1' } as never)
  await clock.settle()
  expect(mine(w)).toMatchObject({ phase: 'waiting', doing: '要你批准：執行 git push origin main', since: NOW + 2 * MINUTE + 1000 })
  w.release?.()
  await call
  expect(mine(w)).toMatchObject({ phase: 'running', doing: '執行 git push origin main', isBusy: false })

  // The person went to another conversation; the turn ends meanwhile.
  w.surfaces = []
  await $.session.detach({ surface: 'desktop', clientId: 'desktop-2', reason: 'detach' } as never)
  await $.turn.complete({ turnId: 't1', answer: '推上去了。\n\n要我開 PR 嗎？', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await clock.settle()
  expect(mine(w)).toMatchObject({ phase: 'done', outcome: 'answered', isSeen: false, answer: '推上去了。\n\n要我開 PR 嗎？' })

  // Back on screen: seen.
  w.surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-2' } as never)
  await clock.settle()
  expect(mine(w)).toMatchObject({ phase: 'done', isSeen: true })

  // A turn stopped by the person is no news to them; one cut off when the conversation stops is.
  await $.turn.start({ text: '再來', turnId: 't2' } as never)
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 10, isAborted: true, reason: 'aborted' } as never)
  expect(mine(w)).toMatchObject({ phase: 'idle', isSeen: true })
  await $.turn.start({ text: '最後一次', turnId: 't3' } as never)
  await $.session.end({ reason: 'other', sessionId: 'cli-1', resume: { id: 'cli-1' } } as never)
  expect(mine(w)).toMatchObject({ phase: 'done', outcome: 'cut', isSeen: false })
})

test('the board lists the other conversations by section; a press jumps there or unfolds the answer', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, $, {
    'conv:local_a': entry('local_a', { phase: 'waiting', since: NOW - 4 * MINUTE, turnAt: NOW - 9 * MINUTE, doing: '要你批准：執行 git push', ask: '推上去' }),
    'conv:local_b': entry('local_b', {
      phase: 'done',
      since: NOW - 6 * MINUTE,
      answer: '## 回測完成\n勝率 58%，最大回撤 12%。\n\n要我調整停損嗎？',
      outcome: 'answered',
      isSeen: false,
    }),
    'conv:local_c': entry('local_c', { phase: 'running', since: NOW - 12 * MINUTE, turnAt: NOW - 12 * MINUTE, doing: '執行 npm test', isBusy: true }),
    'conv:local_d': entry('local_d', { phase: 'done', answer: 'old', outcome: 'answered', isSeen: true }),
    // Archived since: the desktop lists it no more.
    'conv:local_x': entry('local_x', { phase: 'done', answer: 'x', outcome: 'answered', isSeen: false }),
  })
  mock.env(on, { OS: 'Windows_NT' })
  w.sessions = [
    { sessionId: 'local_a', title: '元大用戶買賣資訊同步', cwd: 'D:\\程式\\Stock', link: link('local_a'), isRunning: true },
    { sessionId: 'local_b', title: '國光買賣判斷', cwd: 'D:\\程式\\Stock', link: link('local_b'), isRunning: false },
    { sessionId: 'local_c', title: '每日推薦觀察功能', cwd: 'D:\\程式\\Stock', link: link('local_c'), isRunning: true },
    { sessionId: 'local_d', title: '閒著的', cwd: 'D:\\程式\\Stock', link: link('local_d'), isRunning: false },
    { sessionId: 'local_e', title: '還沒裝看板的', cwd: 'D:\\程式\\Stickers', link: link('local_e'), isRunning: true },
    { sessionId: 'local_old', title: '封存的', cwd: 'D:\\程式\\Stock', link: link('local_old'), isRunning: false, isArchived: true },
  ]
  await $.session.start(START)
  await clock.settle()

  for (const surface of SURFACES) {
    const text = await drawn($, surface)
    expect(text).toContain('等你回 1')
    expect(text).toContain('跑完沒看 1')
    expect(text).toContain('正在跑 2')
    expect(text).toContain('元大用戶買賣資訊同步')
    expect(text).toContain('要你批准：執行 git push')
    expect(text).toContain('等了 4 分鐘')
    expect(text).toContain('你說：推上去')
    expect(text).toContain('回測完成（有問你）')
    expect(text).toContain('每日推薦觀察功能')
    expect(text).toContain('正在：執行 npm test')
    expect(text).toContain('還沒裝看板的')
    expect(text).not.toContain('閒著的')
    expect(text).not.toContain('local_x')
    // This conversation is the one on screen, not a row.
    expect(text).not.toContain('儀表板設計')
  }

  const ui = await $.ui.mount({ plugin: 'convo-board', surface: 'desktop', component: 'Pane', props: PANE_PROPS as never, requestId: PANE })
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)
  await ui.press({ key: 'peek:local_b' })
  expect(textOf(await ui.drawn())).toContain('勝率 58%，最大回撤 12%。')
  expect((await ui.find({ key: 'peek:local_b', type: 'Button' }))?.props).toMatchObject({ label: '收起' })
  await clock.advance(1000)
  await ui.press({ key: 'peek:local_b' })
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)

  await ui.press({ key: 'go:local_a' })
  expect(w.runs).toEqual([['cmd.exe', '/c', 'start', '', link('local_a')]])
  await ui.unmount()
})

test('a first click lands as focus and jumps; the click that follows it does not jump twice', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { OS: 'Windows_NT' })
  const w = world(on, $, { 'conv:local_a': entry('local_a', { phase: 'running', turnAt: NOW - MINUTE, doing: '讀 a.ts' }) })
  w.sessions = [{ sessionId: 'local_a', title: 'A', cwd: 'D:\\程式\\a', link: link('local_a'), isRunning: true }]
  await $.session.start(START)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'convo-board', surface: 'desktop', component: 'Pane', props: PANE_PROPS as never, requestId: PANE })
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: 'convo-board', element: 'go:local_a', origin: { kind: 'person' } } as never)
  await clock.settle()
  await ui.press({ key: 'go:local_a' })
  expect(w.runs).toEqual([['cmd.exe', '/c', 'start', '', link('local_a')]])
  // A ring another plugin moves is no click.
  await clock.advance(5000)
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: 'convo-board', element: 'go:local_a', origin: { kind: 'plugin', name: 'x' } } as never)
  await clock.settle()
  expect(w.runs).toHaveLength(1)
  await ui.unmount()
})

test('once the board holds the keys, Tab walks it without jumping, and a click still jumps', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { OS: 'Windows_NT' })
  const w = world(on, $, { 'conv:local_a': entry('local_a', { phase: 'running', turnAt: NOW - MINUTE, doing: '讀 a.ts' }) })
  w.sessions = [{ sessionId: 'local_a', title: 'A', cwd: 'D:\\程式\\a', link: link('local_a'), isRunning: true }]
  await $.session.start(START)
  await clock.settle()
  const focus = async () => {
    await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: 'convo-board', element: 'go:local_a', origin: { kind: 'person' } } as never)
    await clock.settle()
  }

  const ui = await $.ui.mount({ plugin: 'convo-board', surface: 'desktop', component: 'Pane', props: PANE_PROPS as never, requestId: PANE })
  // The desktop may draw the board holding the keys just before the ring move of the click that gave them.
  await ui.redraw({ ...PANE_PROPS, isFocused: true } as never)
  await focus()
  expect(w.runs).toHaveLength(1)
  // Then Tab walks the board without jumping, and a click jumps by itself.
  await clock.advance(5000)
  await focus()
  expect(w.runs).toHaveLength(1)
  await ui.press({ key: 'go:local_a' })
  expect(w.runs).toHaveLength(2)
  await ui.unmount()

  // In the terminal, Tab right after ctrl+x tab only walks it too.
  await clock.advance(5000)
  const term = await $.ui.mount({ plugin: 'convo-board', surface: 'terminal', component: 'Pane', props: PANE_PROPS as never, requestId: PANE })
  await term.redraw({ ...PANE_PROPS, isFocused: true } as never)
  await focus()
  expect(w.runs).toHaveLength(2)
  await term.unmount()
})

// The person's close mark raises `ui.close`, which a test cannot: the conversation starts with its board closed.
test('a conversation whose board the person closed opens it no more by itself, until the command opens it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { OS: 'Windows_NT' })
  const w = world(on, $, { [`closed:${ME}`]: true })
  await $.session.start(START)
  await clock.settle()
  expect(w.opened).toEqual([])
  w.surfaces = []
  await $.session.detach({ surface: 'desktop', clientId: 'desktop-2', reason: 'detach' } as never)
  w.surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop-2' } as never)
  await clock.settle()
  expect(w.opened).toEqual([])

  const ran = await $.command.run({ command: 'convo-board', args: '' } as never)
  expect(ran.text).toBe('看板打開了。')
  expect(w.opened).toEqual([PANE])
  expect(w.kept.has(`closed:${ME}`)).toBe(false)
})

test('a terminal conversation tells the boards too, under its transcript id, and opens no board by itself', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, {})
  const w = world(on, $)
  w.isDesktop = false
  w.surfaces = ['terminal']
  await $.session.start({ cwd: '/home/u/proj', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(60_000)
  expect(w.opened).toEqual([])
  expect(w.kept.get('conv:cli-1')).toMatchObject({ id: 'cli-1', isDesktop: false, link: null })

  // Its board, opened by the command, shows what the store holds: no desktop list drops anything.
  w.kept.set('conv:local_a', entry('local_a', { phase: 'running', turnAt: NOW, doing: '讀 a.ts', isBusy: true }))
  await $.command.run({ command: 'convo-board', args: '' } as never)
  const text = await drawn($, 'terminal')
  expect(text).toContain('正在：讀 a.ts')
})
