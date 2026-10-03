import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, SessionRateLimit } from 'claude-code'

const NOW = Date.parse('2026-10-03T10:00:00Z')
const HOUR = 3600_000
const DOGS = ['米克斯', '柴犬', '臘腸狗', '哈士奇', '黃金獵犬', '吉娃娃', '狗狗幣', '忠犬八公', '地獄三頭犬', '天狗']
const START = { cwd: '.', surface: 'terminal', isInteractive: true } as never

function limits(five: number, week: number, fiveResetsAt = NOW + 2 * HOUR): SessionRateLimit[] {
  return [
    { kind: 'five_hour', percentUsed: five, resetsAt: new Date(fiveResetsAt).toISOString() },
    { kind: 'seven_day', percentUsed: week, resetsAt: new Date(NOW + 4 * 24 * HOUR).toISOString() },
  ]
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const element = node as RenderElement & { children?: unknown[] }
  return (element.children ?? []).map(textOf).join(' ')
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
} as const

// The engine beneath the plugin: usage the test moves, and every toast and log line it was asked to show.
function world(on: On, rateLimits: SessionRateLimit[]) {
  const state = { rateLimits, startedAt: NOW, shown: [] as string[] }
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.measure', ($, e) => ({ changed: (e as { changed: string[] }).changed }) as never)
  on('turn.start', ($, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on(
    'session.usage',
    () =>
      ({
        value: { startedAt: state.startedAt, context: { window: 200_000 }, rateLimits: state.rateLimits },
      }) as never,
  )
  on('ui.toast', ($, e) => {
    state.shown.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.log', ($, e) => {
    state.shown.push(`log: ${(e as { text: string }).text}`)
    return { value: undefined } as never
  })
  return state
}

async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'quota-pets', surface, component: 'AbovePrompt', props: BAND_PROPS as never })
  return textOf(await ui.drawn())
}

async function measure($: Engine, rateLimits: SessionRateLimit[]): Promise<void> {
  await $.session.measure({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] } as never)
}

test('a conversation pulls a pet that follows the quota to its death and is reborn at the reset', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(12.3, 20.2))

  await $.session.start(START)
  // Opening a conversation is quiet: no toast, no transcript line.
  expect(w.shown).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await band($, surface)
    expect(drawn).toMatch(/\[(N|R|SR|SSR|UR)\]/)
    // Rounded up, as the usage panel shows them.
    expect(drawn).toContain('13%')
    expect(drawn).toContain('21%')
    expect(drawn).toContain('飼料(週)')
  }

  for (const pct of [45, 70, 87, 92, 96, 99.5, 100]) {
    w.rateLimits = limits(pct, 40)
    await measure($, w.rateLimits)
    const drawn = await band($)
    expect(drawn).toContain(`${Math.ceil(pct)}%`)
    console.log(`${pct}% → ${drawn}`)
  }
  // The fun ones still pop: two ghost-story warnings, then the death.
  expect(w.shown.some(text => text.includes('(✖╭╮✖)'))).toBe(true)
  expect(w.shown.filter(text => text.includes('額度')).length).toBe(2)

  await clock.advance(3 * HOUR)
  w.rateLimits = limits(3, 41, NOW + 8 * HOUR)
  await measure($, w.rateLimits)
  expect(w.shown.some(text => text.includes('轉生成'))).toBe(true)
  console.log(w.shown.join('\n'))

  const dex = await $.command.run({ command: 'petdex', args: '' } as never)
  expect(dex.text).toContain('寵物圖鑑')
  expect(dex.text).toContain('總抽數 2')
  console.log(dex.text)
  const ten = await $.command.run({ command: 'petdex', args: '十連' } as never)
  console.log(ten.text)
})

test('every conversation pulls its own pet, and going back to one brings its pet back', { timeoutMs: 20_000 }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(30, 20))
  const pulls = async () => {
    const dex = await $.command.run({ command: 'petdex', args: '' } as never)
    return Number(/總抽數 (\d+)/.exec(dex.text)?.[1])
  }

  await $.session.start(START)
  const first = await band($)
  expect(await pulls()).toBe(1)

  // A hot reload runs session.start again in the same conversation.
  await $.session.start(START)
  expect(await pulls()).toBe(1)

  // /clear: a new conversation in the same session.
  w.startedAt = NOW + 60_000
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  expect(await pulls()).toBe(2)

  // Resuming the first conversation.
  w.startedAt = NOW
  await $.turn.start({ text: 'hi again', turnId: 't2' } as never)
  expect(await pulls()).toBe(2)
  expect(await band($)).toBe(first)

  const dex = await $.command.run({ command: 'petdex', args: '' } as never)
  expect(dex.text).toContain('總抽數 2')
})

test('a conversation started after the quota ran out pulls a pet that is dead on arrival', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(100, 60))

  await $.session.start(START)
  // Dead on arrival is funny enough to announce, even at the start.
  expect(w.shown.some(text => text.includes('一出蛋就陣亡'))).toBe(true)
  expect(w.shown.some(text => text.includes('(✖╭╮✖)'))).toBe(false)
  const drawn = await band($)
  expect(drawn).toContain('100%')
  console.log(drawn)
})

test('every dog draws at every stage of the quota', { timeoutMs: 60_000 }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  world(on, limits(10, 20))
  await $.session.start(START)

  for (const name of DOGS) {
    const rows: string[] = []
    for (const pct of [10, 45, 70, 87, 92, 96, 99, 100]) {
      const said = await $.command.run({ command: 'petdex', args: `預覽 ${pct} ${name}` } as never)
      expect(said.text).toContain(`預覽 ${pct}%`)
      const drawn = await band($)
      expect(drawn).toContain(name)
      rows.push(`${String(pct).padStart(3)}% ${drawn.split(' 5h ')[0]}`)
    }
    console.log(rows.join('\n'))
  }
  const missing = await $.command.run({ command: 'petdex', args: '預覽 50 貴賓狗' } as never)
  expect(missing.text).toContain('沒有這隻')
})
