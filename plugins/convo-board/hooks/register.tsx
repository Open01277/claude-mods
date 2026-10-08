import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ConvoBoardEntry, ConvoBoardMe, ConvoBoardRow, ConvoBoardSection, ConvoBoardSession } from '../types'
import { buildView, cut, describeAsk, describeTool, firstLine, safeLink } from './board'

const PLUGIN = 'convo-board'
const PANE = 'convo-board'
const TITLE = '看板'
const COMMAND = 'convo-board'
// The store's keys: each conversation's line, and the conversations whose board the person closed.
const ENTRY = 'conv:'
const CLOSED = 'closed:'
// The board's buttons, keyed by the conversation they act on.
const GO = 'go:'
const PEEK = 'peek:'
// The desktop's own tools: who this conversation is, and every conversation it keeps.
const DESKTOP = 'ccd_session_mgmt'

const meAtom = atom({ plugin: 'convo-board', key: 'me' } as const, null)
const entryAtom = atom({ plugin: 'convo-board', key: 'entry' } as const, null)
const viewAtom = atom({ plugin: 'convo-board', key: 'view' } as const, null)
const openAtom = atom({ plugin: 'convo-board', key: 'open' } as const, {})

// A sign of life this often; past STALE_MS without one, a board takes the conversation for stopped.
const BEAT_MS = 30_000
// While someone looks at a board it reads the others this often, and the desktop's list less often.
const REFRESH_MS = 3000
const LIST_MS = 6000
// A run of tool calls is written once.
const SAVE_MS = 800
const ANSWER_MAX = 4000
const ASK_MAX = 100
// A press may come twice, by the focus ring and by the click.
const JUMP_GAP_MS = 1500
const PEEK_GAP_MS = 600
const DAY = 24 * 60 * 60_000
// Lines nobody writes any more: a quiet one goes after three days, any after two weeks.
const QUIET_KEEP_MS = 3 * DAY
const KEEP_MS = 14 * DAY
// At start the desktop may not answer yet: asked again after these waits.
const WHO_RETRY_MS = [3000, 10_000, 30_000]

const SECTIONS: readonly ConvoBoardSection[] = ['waiting', 'unseen', 'running']
const SECTION_LABEL: Record<ConvoBoardSection, string> = { waiting: '等你回', unseen: '跑完沒看', running: '正在跑' }
// Theme keys where there is one, so the board reads on light themes too.
const SECTION_COLOR: Record<ConvoBoardSection, string> = { waiting: 'warning', unseen: 'blue', running: 'success' }

// The tool calls in hand, by id, and what each does.
const busy = new Map<string, string>()
// The last call the engine put to a decider, and the dialog the person has in front of them; `tool` null: any call
// that ends answers it.
let asked: { id: string; tool: string } | null = null
let waitingOn: { id: string | null; tool: string | null } | null = null
let saveTimer: Timer | null = null
let sessions: ConvoBoardSession[] | null = null
let listedAt = 0
let shown = ''
let lastJump = 0
const lastPeek = new Map<string, number>()
let opener: readonly string[] | null = null

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return (text.split('\n')[0] ?? '').slice(0, 120)
}

// A desktop tool's JSON answer; null where there is no desktop or it refused.
async function askDesktop($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const result = await $.mcp.call(DESKTOP, tool, args)
    if (result.isError) return null
    return JSON.parse(result.content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join(''))
  } catch {
    return null
  }
}

async function whoAmI($: EngineInterface): Promise<ConvoBoardMe> {
  const self = (await askDesktop($, 'get_session', { session_id: 'self' })) as Record<string, unknown> | null
  const cwd = await $.session.cwd()
  if (typeof self?.sessionId === 'string') {
    return {
      id: self.sessionId,
      title: typeof self.title === 'string' && self.title !== '' ? self.title : null,
      cwd: typeof self.cwd === 'string' ? self.cwd : cwd,
      link: safeLink(self.link),
      isDesktop: true,
    }
  }
  return { id: await $.session.id(), title: null, cwd, link: null, isDesktop: false }
}

async function listSessions($: EngineInterface): Promise<ConvoBoardSession[] | null> {
  const list = await askDesktop($, 'list_sessions', { limit: 100 })
  if (!Array.isArray(list)) return null
  return list.flatMap((item: Record<string, unknown>) =>
    typeof item.sessionId === 'string' && item.isArchived !== true
      ? [
          {
            id: item.sessionId,
            title: typeof item.title === 'string' ? item.title : '',
            cwd: typeof item.cwd === 'string' ? item.cwd : '',
            link: safeLink(item.link),
            isRunning: item.isRunning === true,
          },
        ]
      : [],
  )
}

// Someone draws this conversation now: on the desktop, it is on screen.
async function isLooked($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

function blank(me: ConvoBoardMe, now: number): ConvoBoardEntry {
  return {
    v: 1,
    id: me.id,
    title: me.title,
    cwd: me.cwd,
    link: me.link,
    isDesktop: me.isDesktop,
    phase: 'idle',
    since: now,
    turnAt: null,
    ask: null,
    doing: null,
    isBusy: false,
    answer: null,
    outcome: null,
    isSeen: true,
    beat: now,
  }
}

async function flush($: EngineInterface): Promise<void> {
  saveTimer?.cancel()
  saveTimer = null
  const entry = await read($, entryAtom)
  if (entry === null) return
  await $.store.set(`${ENTRY}${entry.id}`, { ...entry, beat: await $.clock.now() })
}

function saveSoon($: EngineInterface): void {
  if (saveTimer !== null) return
  saveTimer = $.clock.after(SAVE_MS, () => {
    saveTimer = null
    void flush($).catch(error => $.ui.log(`save failed: ${reasonOf(error)}`, { to: 'debug' }))
  })
}

// Changes this conversation's line, for the boards: at once when its phase moves, else with the next quiet moment.
async function change($: EngineInterface, fn: (entry: ConvoBoardEntry) => ConvoBoardEntry, isNow: boolean): Promise<void> {
  await update($, entryAtom, entry => (entry === null ? null : fn(entry)))
  if (isNow) await flush($)
  else saveSoon($)
}

// Who this conversation is, and its line: a reload keeps the one in hand, a conversation coming back finds its own.
async function settle($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const me = await whoAmI($)
  await update($, meAtom, () => me)
  const held = await read($, entryAtom)
  if (held?.id === me.id) {
    await flush($)
    return
  }
  const kept = (await $.store.get(`${ENTRY}${me.id}`)) as ConvoBoardEntry | undefined
  const looked = await isLooked($)
  let entry = blank(me, now)
  if (kept?.v === 1) {
    const ours = { ...kept, title: me.title ?? kept.title, cwd: me.cwd, link: me.link, isDesktop: me.isDesktop }
    // A turn it was in when its process stopped was cut off; its last answer stands.
    const wasCut = kept.phase === 'running' || kept.phase === 'waiting'
    entry = wasCut
      ? { ...ours, phase: 'done', since: kept.beat, turnAt: null, doing: null, isBusy: false, outcome: 'cut', isSeen: looked }
      : { ...ours, isBusy: false, isSeen: kept.isSeen || looked }
  }
  await update($, entryAtom, () => entry)
  await flush($)
}

// Asks the desktop again who this is: it may not have answered at start, a /clear may move the session, and the
// desktop names a conversation after its first exchange.
async function reidentify($: EngineInterface): Promise<void> {
  const me = await read($, meAtom)
  const found = await whoAmI($)
  if (me === null || (me.isDesktop && !found.isDesktop)) return
  if (found.id === me.id && found.title === me.title && found.link === me.link) return
  await update($, meAtom, () => found)
  if (found.id !== me.id) await $.store.delete(`${ENTRY}${me.id}`)
  await change(
    $,
    entry => ({ ...entry, id: found.id, title: found.title ?? entry.title, cwd: found.cwd, link: found.link, isDesktop: found.isDesktop }),
    true,
  )
  if (!me.isDesktop && found.isDesktop) await autoOpen($)
}

// Every conversation's line in the store, the ones nobody writes any more swept out.
async function entries($: EngineInterface, now: number): Promise<ConvoBoardEntry[]> {
  const found: ConvoBoardEntry[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(ENTRY)) continue
    const entry = (await $.store.get(key)) as ConvoBoardEntry | undefined
    if (entry?.v !== 1) continue
    const age = now - entry.beat
    const isQuiet = entry.phase === 'idle' || (entry.phase === 'done' && entry.isSeen)
    if (age > KEEP_MS || (isQuiet && age > QUIET_KEEP_MS)) {
      await $.store.delete(key)
      await $.store.delete(`${CLOSED}${entry.id}`)
      continue
    }
    found.push(entry)
  }
  return found
}

// Draws the board afresh from every conversation's line: only where someone looks at it, unless asked.
async function refresh($: EngineInterface, isForced: boolean): Promise<void> {
  if (!isForced) {
    if (!(await isLooked($))) return
    if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
  }
  const now = await $.clock.now()
  const me = await read($, meAtom)
  if (me?.isDesktop === true && (sessions === null || now - listedAt >= LIST_MS)) {
    sessions = await listSessions($)
    listedAt = now
  }
  const view = buildView(await entries($, now), me?.isDesktop === true ? sessions : null, me?.id ?? '', now)
  const text = JSON.stringify(view)
  if (text === shown) return
  shown = text
  await update($, viewAtom, () => view)
}

// The desktop opens the board beside each conversation it shows, unless the person closed it there.
async function autoOpen($: EngineInterface): Promise<void> {
  const me = await read($, meAtom)
  if (me === null || !me.isDesktop) return
  if (!(await $.session.surfaces()).includes('desktop')) return
  if ((await $.store.get(`${CLOSED}${me.id}`)) === true) return
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) return
  await refresh($, true)
  await $.ui.open({ id: PANE, title: TITLE })
}

async function openerOf($: EngineInterface): Promise<readonly string[]> {
  if (opener !== null) return opener
  if ((await $.env.get('OS')) === 'Windows_NT') {
    // `start` hands the link to the app registered for claude://; its first quoted word is a window title.
    opener = ['cmd.exe', '/c', 'start', '']
  } else {
    const uname = await $.process.run(['uname', '-s']).catch(() => null)
    opener = uname?.stdout.trim() === 'Darwin' ? ['open'] : ['xdg-open']
  }
  return opener
}

// The desktop shows the conversation its link names, in place of the one on screen.
async function jump($: EngineInterface, link: string): Promise<void> {
  try {
    const ran = await $.process.run([...(await openerOf($)), link], { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) $.ui.toast(`跳不過去：${firstLine(ran.stderr, 60) || `exit ${ran.exitCode}`}`)
  } catch (error) {
    $.ui.toast(`跳不過去：${reasonOf(error)}`)
  }
}

async function press($: EngineInterface, key: string): Promise<void> {
  const now = await $.clock.now()
  if (key.startsWith(GO)) {
    if (now - lastJump < JUMP_GAP_MS) return
    lastJump = now
    const row = (await read($, viewAtom))?.rows.find(one => one.id === key.slice(GO.length))
    if (row?.link) await jump($, row.link)
    return
  }
  if (key.startsWith(PEEK)) {
    if (now - (lastPeek.get(key) ?? 0) < PEEK_GAP_MS) return
    lastPeek.set(key, now)
    const id = key.slice(PEEK.length)
    await update($, openAtom, open => ({ ...open, [id]: open[id] !== true }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: COMMAND,
      description: '打開看板：別的對話哪些在等你回、跑完沒看、正在跑',
      immediate: true,
    })
    await settle($).catch(error => $.ui.log(`start failed: ${reasonOf(error)}`, { to: 'debug' }))
    $.clock.every(BEAT_MS, () => void flush($).catch(() => undefined))
    $.clock.every(REFRESH_MS, () => {
      void refresh($, false).catch(error => $.ui.log(`refresh failed: ${reasonOf(error)}`, { to: 'debug' }))
    })
    for (const ms of WHO_RETRY_MS) $.clock.after(ms, () => void reidentify($).catch(() => undefined))
    $.clock.after(0, () => void autoOpen($).catch(error => $.ui.log(`open failed: ${reasonOf(error)}`, { to: 'debug' })))

    return result
  })

  // The person brought the conversation on screen: what it finished is seen, and the board is beside it.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(0, async () => {
      await change($, entry => (entry.phase === 'done' && !entry.isSeen ? { ...entry, isSeen: true } : entry), true)
      await autoOpen($)
      await refresh($, true)
    })

    return result
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    busy.clear()
    asked = null
    waitingOn = null
    const ask = firstLine(e.text, ASK_MAX)
    await change(
      $,
      entry => ({ ...entry, phase: 'running', since: now, turnAt: now, ask: ask === '' ? entry.ask : ask, doing: null, isBusy: false }),
      true,
    )

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = e.tool_use_id ?? `${tool}@${await $.clock.now()}`
    const words = describeTool(tool, e as unknown as Record<string, unknown>)
    busy.set(id, words)
    await change($, entry => (entry.phase === 'running' ? { ...entry, doing: words, isBusy: true } : entry), false)
    try {
      return await next(e)
    } finally {
      busy.delete(id)
      // The call the dialog was about ended: the person answered it, one way or the other.
      const isAnswered =
        waitingOn !== null && (waitingOn.id === null ? waitingOn.tool === null || waitingOn.tool === tool : waitingOn.id === id)
      if (isAnswered) waitingOn = null
      const now = await $.clock.now()
      const last = [...busy.values()].at(-1)
      await change(
        $,
        entry => {
          if (isAnswered && entry.phase === 'waiting') {
            return { ...entry, phase: 'running', since: now, doing: last ?? words, isBusy: busy.size > 0 }
          }
          return entry.phase === 'running' ? { ...entry, doing: last ?? entry.doing, isBusy: busy.size > 0 } : entry
        },
        isAnswered,
      )
    }
  })

  // Every call goes through here; the one a dialog follows is the one the person is asked about.
  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    if (result.decision === 'ask' && e.tool_use_id !== undefined) asked = { id: e.tool_use_id, tool: e.tool }

    return result
  })

  // A dialog is in front of the person: a permission, a question, a plan to approve. A call the auto mode decides
  // raises none.
  on('classic.PermissionRequest', async ($, e, next) => {
    const now = await $.clock.now()
    waitingOn = { id: asked?.tool === e.tool_name ? asked.id : null, tool: e.tool_name }
    const words = describeAsk(e.tool_name, e.tool_input)
    await change(
      $,
      entry => (entry.phase === 'running' || entry.phase === 'waiting' ? { ...entry, phase: 'waiting', since: now, doing: words } : entry),
      true,
    )

    return next(e)
  })

  // An MCP server asks the person to fill something in.
  on('classic.Elicitation', async ($, e, next) => {
    const now = await $.clock.now()
    waitingOn = { id: null, tool: null }
    const words = `${e.mcp_server_name} 要你填資料`
    await change(
      $,
      entry => (entry.phase === 'running' || entry.phase === 'waiting' ? { ...entry, phase: 'waiting', since: now, doing: words } : entry),
      true,
    )

    return next(e)
  })

  on('classic.ElicitationResult', async ($, e, next) => {
    const now = await $.clock.now()
    waitingOn = null
    await change($, entry => (entry.phase === 'waiting' ? { ...entry, phase: 'running', since: now } : entry), true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn is a part of this conversation's.
    if (e.agentId !== undefined) return result
    const now = await $.clock.now()
    busy.clear()
    asked = null
    waitingOn = null
    const looked = await isLooked($)
    const answer = e.answer.trim()
    await change(
      $,
      entry =>
        e.isAborted
          ? { ...entry, phase: 'idle', since: now, turnAt: null, doing: null, isBusy: false, isSeen: true }
          : {
              ...entry,
              phase: 'done',
              since: now,
              turnAt: null,
              doing: null,
              isBusy: false,
              answer: answer === '' ? null : cut(answer, ANSWER_MAX),
              outcome: e.reason === 'answer' ? 'answered' : 'failed',
              isSeen: looked,
            },
      true,
    )
    $.clock.after(0, () => void reidentify($).catch(() => undefined))

    return result
  })

  on('session.end', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.reason === 'clear') {
      await change(
        $,
        entry => ({ ...entry, phase: 'idle', since: now, turnAt: null, ask: null, doing: null, isBusy: false, answer: null, outcome: null, isSeen: true }),
        true,
      ).catch(() => undefined)
      $.clock.after(1000, () => void reidentify($).catch(() => undefined))
    } else {
      // The conversation stops: a turn it is in is cut off, for the other boards to show.
      await change(
        $,
        entry =>
          entry.phase === 'running' || entry.phase === 'waiting'
            ? { ...entry, phase: 'done', since: now, doing: null, isBusy: false, outcome: 'cut', isSeen: false }
            : entry,
        true,
      ).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const me = await read($, meAtom)
    if (me !== null) await $.store.delete(`${CLOSED}${me.id}`)
    await refresh($, true)
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? '看板打開了。' : `看板等畫面夠寬就會出現：${opened.reason}` }
  })

  // Closed by the person's hand: this conversation opens it no more by itself, until the command opens it again.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    const me = await read($, meAtom)
    if (e.origin.kind === 'person' && me !== null) await $.store.set(`${CLOSED}${me.id}`, true)

    return result
  })

  // While the prompt holds the keys, a click on the desktop's pane only moves its focus ring onto a button, and the
  // press waits for a second click: the ring landing there by the person's hand presses it.
  on('ui.focus', { component: 'Pane' }, async ($, e, next) => {
    const result = await next(e)
    const element = e.element
    if (result.deny === undefined && e.plugin === PLUGIN && e.requestId === PANE && e.origin.kind === 'person' && element !== undefined) {
      $.clock.after(0, () => void press($, element).catch(() => undefined))
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const open = await read($, openAtom)
    if (view === null) return <Text dimColor>讀取中…</Text>
    if (view.rows.length === 0) return <Text dimColor>其他對話都沒在跑，也沒有在等你。</Text>

    const drawRow = (row: ConvoBoardRow) => {
      const isOpen = open[row.id] === true && row.answer !== null
      const detail = row.asksBack ? `${row.detail}（有問你）` : row.detail
      const buttons = [
        ...(row.link === null
          ? []
          : [<Button key={`${GO}${row.id}`} label="跳過去" onPress={() => void press($, `${GO}${row.id}`)} />]),
        ...(row.answer === null
          ? []
          : [<Button key={`${PEEK}${row.id}`} label={isOpen ? '收起' : '看結果'} onPress={() => void press($, `${PEEK}${row.id}`)} />]),
      ]
      // A card: the project and how long on top, then the title, what it does, and what the person said.
      return (
        <Box
          key={`row:${row.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={SECTION_COLOR[row.section]}
          borderDimColor
          paddingX={1}
        >
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1} flexShrink={1}>
              <Text bold inverse color={SECTION_COLOR[row.section]} wrap="truncate-end">{` ${row.folder} `}</Text>
              {!row.isDesktop && <Text dimColor>終端機</Text>}
            </Box>
            <Text dimColor>{row.time}</Text>
          </Box>
          <Text bold wrap="truncate-end">{row.title}</Text>
          {row.isError ? <Text color="error">{detail}</Text> : <Text wrap="truncate-end">{detail}</Text>}
          {row.ask !== null && <Text dimColor wrap="truncate-end">{`你說：${row.ask}`}</Text>}
          {buttons.length > 0 && (
            <Box flexDirection="row" columnGap={1}>
              {buttons}
            </Box>
          )}
          {isOpen && row.answer !== null && <Markdown text={row.answer} />}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {SECTIONS.flatMap(section => {
          const rows = view.rows.filter(row => row.section === section)
          return rows.length === 0
            ? []
            : [
                <Box key={`section:${section}`} flexDirection="column">
                  <Text bold color={SECTION_COLOR[section]}>{`${SECTION_LABEL[section]} ${rows.length}`}</Text>
                  {rows.map(drawRow)}
                </Box>,
              ]
        })}
      </Box>
    )
  })
}
