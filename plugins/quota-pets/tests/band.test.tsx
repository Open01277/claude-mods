import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, SessionRateLimit } from 'claude-code'

// Local time, so the pet keeps the same hours wherever the tests run: 18:00, nowhere near bedtime.
const NOW = new Date(2026, 9, 3, 18, 0).getTime()
const MINUTE = 60_000
const HOUR = 3600_000
const DAY = 24 * HOUR
const CATS = ['普通貓', '橘貓', '賓士貓', '鍵盤貓', '實習生貓', '墨鏡貓', '工程師貓', '黑貓', 'PM貓', '招財貓', '太空貓', '薛丁格的貓', '液態貓', '貓神']
const DOGS = ['米克斯', '柴犬', '臘腸狗', '單身狗', '社畜狗', '哈士奇', '黃金獵犬', '吉娃娃', '舔狗', '看門狗', '狗狗幣', '忠犬八公', '熱狗', '狗頭軍師', '地獄三頭犬', '天狗']
const START = { cwd: '.', surface: 'terminal', isInteractive: true } as never

function limits(five: number, week: number, fiveResetsAt = NOW + 2 * HOUR, weekResetsAt = NOW + 4 * DAY): SessionRateLimit[] {
  return [
    { kind: 'five_hour', percentUsed: five, resetsAt: new Date(fiveResetsAt).toISOString() },
    { kind: 'seven_day', percentUsed: week, resetsAt: new Date(weekResetsAt).toISOString() },
  ]
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const element = node as RenderElement & { children?: unknown[] }
  return (element.children ?? []).map(textOf).join(' ')
}

// The week's lane as drawn: each dot, Pac-Man and ghost with its color, or `dim`.
function laneOf(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return []
  const { props, children = [] } = node as { props?: Record<string, unknown>; children?: unknown[] }
  const [only] = children
  if (children.length === 1 && typeof only === 'string' && /^[•ᗧᗣ]$/.test(only)) {
    return [`${only}${props?.dimColor === true ? 'dim' : String(props?.color)}`]
  }
  return children.flatMap(laneOf)
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
} as const

type Context = { window: number; tokens?: number; percent?: number }

const SUMMARY = { role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }

// The engine beneath the plugin: usage the test moves, and every toast and log line it was asked to show.
function world(on: On, rateLimits: SessionRateLimit[]) {
  const state = {
    rateLimits,
    startedAt: NOW,
    context: { window: 200_000 } as Context,
    // Where auto-compaction runs, as the breakdown reports it; undefined while it is off.
    threshold: 160_000 as number | undefined,
    // The context by category, as /context breaks it down.
    categories: [] as { name: string; tokens: number; kind: string }[],
    // The conversation as the next request sends it.
    messages: [] as unknown[],
    // What another plugin draws in the band, beneath this one.
    beneath: null as string | null,
    // What `claude -p /usage` prints; null: it fails, as with no claude on the PATH.
    usage: null as string | null,
    probes: [] as { argv: string[]; env?: Record<string, string> }[],
    commands: [] as string[],
    shown: [] as string[],
  }
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.measure', ($, e) => ({ changed: (e as { changed: string[] }).changed }) as never)
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 165_000, tokensAfter: 21_000 }) as never)
  on('turn.start', ($, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('command.register', ($, e) => {
    state.commands.push((e as { name: string }).name)
    return { value: { command: (e as { name: string }).name } } as never
  })
  on('session.attach', ($, e) => ({ clientId: (e as { clientId: string }).clientId }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('session.messages', () => ({ value: state.messages }) as never)
  on('session.root', () => ({ value: 'D:\\proj' }) as never)
  on('session.usage', ($, e) => {
    const isBroken = (e as { breakdown?: string }).breakdown !== undefined
    const breakdown = {
      isAutoCompactEnabled: state.threshold !== undefined,
      autoCompactThreshold: state.threshold,
      categories: state.categories,
    }
    const context = isBroken ? { ...state.context, breakdown } : state.context
    return { value: { startedAt: state.startedAt, context, rateLimits: state.rateLimits } } as never
  })
  on('ui.toast', ($, e) => {
    state.shown.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  // The engine draws nothing of its own in the band; another plugin may.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return state.beneath === null ? <Box /> : <Text>{state.beneath}</Text>
  })
  on('process.run', ($, e) => {
    const { argv, init } = e as { argv: string[]; init?: { env?: Record<string, string> } }
    state.probes.push({ argv: [...argv], ...(init?.env === undefined ? {} : { env: init.env }) })
    const ran = { stdout: state.usage ?? '', stderr: '', exitCode: state.usage === null ? 1 : 0, isStdoutTruncated: false, isStderrTruncated: false }
    return { value: ran } as never
  })
  on('ui.log', ($, e) => {
    state.shown.push(`log: ${(e as { text: string }).text}`)
    return { value: undefined } as never
  })
  return state
}

async function draw($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<unknown> {
  const ui = await $.ui.mount({ plugin: 'quota-pets', surface, component: 'AbovePrompt', props: BAND_PROPS as never })
  return ui.drawn()
}

async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  return textOf(await draw($, surface))
}

async function measure($: Engine, rateLimits: SessionRateLimit[]): Promise<void> {
  await $.session.measure({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] } as never)
}

// A response reports the context: the belly fills.
async function eat($: Engine, w: ReturnType<typeof world>, tokens: number): Promise<void> {
  w.context = { window: 200_000, tokens, percent: Math.round((tokens / 200_000) * 100) }
  await $.session.measure({ context: w.context, rateLimits: w.rateLimits, changed: ['context'] } as never)
}

// The person's prompt and the turn it starts, running for `minutes`.
async function turn($: Engine, clock: { advance: (ms: number) => Promise<void> }, id: string, minutes: number): Promise<void> {
  await $.turn.start({ text: 'go', turnId: id } as never)
  await clock.advance(minutes * MINUTE)
  await $.turn.complete({ turnId: id, answer: '', durationMs: minutes * MINUTE, isAborted: false, reason: 'end_turn' } as never)
}

// The pet's line, between 「 and 」.
function lineOf(drawn: string): string {
  return /「(.*)」/.exec(drawn)?.[1] ?? ''
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

test('the week is seven ghosts that Pac-Man eats, one per day', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(10, 0))
  await $.session.start(START)

  // Blue: a day that has come. Dim: one still ahead. Yellow: one eaten before it came. Red: the last of the food.
  const weeks = [
    // Restocked this morning: next week's Saturday, not today's.
    { pct: 0, resetsIn: 6 * DAY + 12 * HOUR, food: 'ᗧᗣᗣᗣᗣᗣᗣᗣ0%·下週六06:00補貨', lane: 'ᗧwarning ᗣblue ᗣdim ᗣdim ᗣdim ᗣdim ᗣdim ᗣdim' },
    { pct: 60, resetsIn: 5 * DAY, food: '••••ᗧᗣᗣᗣ60%·週四18:00補貨·偷吃到後天的份了', lane: '•dim •dim •dim •warning ᗧwarning ᗣwarning ᗣdim ᗣdim' },
    { pct: 21, resetsIn: 95 * HOUR, food: '•ᗧᗣᗣᗣᗣᗣᗣ21%·週三17:00補貨', lane: '•dim ᗧwarning ᗣblue ᗣblue ᗣblue ᗣdim ᗣdim ᗣdim' },
    { pct: 40, resetsIn: 98 * HOUR, food: '••ᗧᗣᗣᗣᗣᗣ40%·週三20:00補貨', lane: '•dim •dim ᗧwarning ᗣblue ᗣdim ᗣdim ᗣdim ᗣdim' },
    {
      pct: 60,
      resetsIn: 20 * HOUR,
      food: '••••ᗧᗣᗣᗣ60%·20h00m後補貨·最後一天還剩3天份，吃大餐！',
      lane: '•dim •dim •dim •dim ᗧwarning ᗣblue ᗣblue ᗣblue',
    },
    {
      pct: 93,
      resetsIn: 2 * DAY,
      food: '••••••ᗧᗣ93%·週一18:00補貨·只剩袋底了…袋子裡…好像有東西在動…',
      lane: '•dim •dim •dim •dim •dim •dim ᗧwarning ᗣerror',
    },
    {
      pct: 100,
      resetsIn: 18 * HOUR,
      food: '•••••••ᗧ100%·18h00m後補貨·吃光了…這週剩下的日子…牠們要吃什麼…',
      lane: '•dim •dim •dim •dim •dim •dim •dim ᗧwarning',
    },
  ]
  for (const { pct, resetsIn, food, lane } of weeks) {
    w.rateLimits = limits(10, pct, NOW + 2 * HOUR, NOW + resetsIn)
    await measure($, w.rateLimits)
    for (const surface of ['terminal', 'desktop'] as const) {
      const tree = await draw($, surface)
      const drawn = textOf(tree)
      expect(drawn.slice(drawn.indexOf('飼料(週)')).replace(/\s+/g, '')).toBe(`飼料(週)${food}`)
      expect(laneOf(tree).join(' ')).toBe(lane)
      if (surface === 'terminal') console.log(drawn)
    }
  }
})

test('every pet draws at every stage of the quota', { timeoutMs: 60_000 }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  world(on, limits(10, 20))
  await $.session.start(START)

  for (const name of [...CATS, ...DOGS]) {
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

test('the context is the belly: it fills toward auto-compaction, a compaction empties it', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(10, 20))
  await $.session.start(START)
  // The threshold is read off the hook's path.
  await clock.advance(1000)
  const mood = lineOf(await band($))
  // No response has reported the context yet: no belly.
  expect(await band($)).not.toContain('肚子')

  // 40k of a 200k window, a quarter of the way to the 160k threshold.
  await eat($, w, 40_000)
  const quarter = await band($)
  expect(quarter).toContain('肚子 ●○○○○ 20%')
  expect(lineOf(quarter)).toBe(mood)
  // The desktop draws the context's own gauge beside the model: the pet keeps its lines, not a second gauge.
  expect(await band($, 'desktop')).not.toContain('肚子 ●')

  // Past three quarters of the way: the pet talks about its belly.
  await eat($, w, 130_000)
  const full = await band($)
  expect(full).toContain('肚子 ●●●●○ 65%')
  expect(lineOf(full)).not.toBe(mood)
  expect(lineOf(full)).toMatch(/token|compact|肚子/)
  expect(w.shown.some(text => text.includes('肚子快撐爆了'))).toBe(false)

  // About to burst: one toast, however many readings follow.
  await eat($, w, 150_000)
  await eat($, w, 152_000)
  const bursting = await band($)
  expect(bursting).toContain('肚子 ●●●●● 76%')
  expect(lineOf(bursting)).not.toBe(lineOf(full))
  expect(w.shown.filter(text => text.includes('肚子快撐爆了')).length).toBe(1)
  expect(w.shown.some(text => text.includes('快要自動壓縮了'))).toBe(true)

  // The engine compacts at its threshold: the pet throws up.
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] } as never)
  expect(w.shown.some(text => text.includes('撐到吐了') && text.includes('165k') && text.includes('21k'))).toBe(true)
  const burped = await band($)
  expect(burped).toContain('肚子 ○○○○○ 剛吐完')
  expect(lineOf(burped)).toMatch(/吐|忘/)

  // The next response reports the emptier context.
  await eat($, w, 30_000)
  expect(await band($)).toContain('肚子 ●○○○○ 15%')

  // A /compact is a diet.
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] } as never)
  expect(w.shown.some(text => text.includes('減肥成功') && text.includes('瘦到 21k'))).toBe(true)
  const slimmed = await band($)
  expect(slimmed).toContain('剛減肥完')
  expect(lineOf(slimmed)).toMatch(/減肥|瘦/)

  // Ten minutes on, it is the pet's own line again.
  await clock.advance(11 * MINUTE)
  expect(lineOf(await band($))).toBe(mood)
  const dex = await $.command.run({ command: 'petdex', args: '' } as never)
  console.log(w.shown.join('\n'))
  console.log(dex.text.split('\n')[1])
})

test('with auto-compaction off, the whole window is the belly', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(10, 20))
  w.threshold = undefined
  await $.session.start(START)
  await clock.advance(1000)

  await eat($, w, 150_000)
  expect(await band($)).toContain('肚子 ●●●●○ 75%')
  expect(w.shown.some(text => text.includes('肚子快撐爆了'))).toBe(false)
  await eat($, w, 185_000)
  expect(w.shown.some(text => text.includes('肚子快撐爆了') && text.includes('/compact'))).toBe(true)
})

test('fifty minutes of work without a break and the pet asks for a walk; a break brings it back cheerful', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(10, 20))
  await $.session.start(START)
  const mood = lineOf(await band($))
  const nags = () => w.shown.filter(text => /分鐘|小時/.test(text)).length

  // Turns with short pauses between them are one run of work.
  for (let index = 0; index < 4; index++) {
    await turn($, clock, `t${index}`, 8)
    await clock.advance(2 * MINUTE)
  }
  expect(nags()).toBe(0)
  expect(lineOf(await band($))).toBe(mood)

  // A long turn: the run goes on while it runs, and passes fifty minutes.
  await turn($, clock, 't4', 12)
  expect(nags()).toBe(1)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(lineOf(await band($, surface))).toContain('分鐘')
  }
  const dex = await $.command.run({ command: 'petdex', args: '' } as never)
  expect(dex.text).toContain('已經連續寫 52 分鐘')

  // Half an hour more, and it asks again.
  await turn($, clock, 't5', 31)
  expect(nags()).toBe(2)
  expect(lineOf(await band($))).toContain('1 小時 23 分')

  // A quarter of an hour away is a break: the walk is off.
  await clock.advance(15 * MINUTE)
  expect(lineOf(await band($))).toBe(mood)

  // Back at it: the pet is glad about the walk, for a while.
  await $.turn.start({ text: 'back', turnId: 't6' } as never)
  const back = lineOf(await band($))
  expect(back).toMatch(/回來|休息完|懶腰/)
  await $.turn.complete({ turnId: 't6', answer: '', durationMs: 0, isAborted: false, reason: 'end_turn' } as never)
  await clock.advance(11 * MINUTE)
  expect(lineOf(await band($))).toBe(mood)
  expect(nags()).toBe(2)
  console.log(w.shown.join('\n'))
})

test('past midnight the pet yawns and says goodnight once; the quota scares still come first', { timeoutMs: 20_000 }, async ($, on) => {
  const night = new Date(2026, 9, 4, 1, 30).getTime()
  const clock = mock.clock(on, { now: night })
  mock.store(on)
  const w = world(on, limits(10, 20, night + 2 * HOUR, night + 4 * DAY))
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await band($, surface)).toContain('zZ')
  }
  await turn($, clock, 'n1', 1)
  await turn($, clock, 'n2', 1)
  const goodnights = w.shown.filter(text => text.includes('睡'))
  expect(goodnights.length).toBe(1)
  expect(goodnights[0]).toContain('01:3')

  w.rateLimits = limits(92, 20, night + 2 * HOUR, night + 4 * DAY)
  await measure($, w.rateLimits)
  expect(await band($)).not.toContain('zZ')

  // Morning: no more yawning.
  w.rateLimits = limits(10, 20, night + 6 * HOUR, night + 4 * DAY)
  await measure($, w.rateLimits)
  await clock.advance(4 * HOUR)
  expect(await band($)).not.toContain('zZ')
  console.log(goodnights.join('\n'))
})

test('every pet acts out every scene', { timeoutMs: 60_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(10, 20))
  await $.session.start(START)
  await clock.advance(1000)
  // The preview's belly measures against the real threshold: 160k of 200k.
  await eat($, w, 20_000)

  const cells: Record<string, string> = { '肚子 70': '●●●●○', '肚子 95': '●●●●●' }
  const scenes = ['深夜', '散步', '回來', '肚子 70', '肚子 95', '吐', '減肥']
  for (const name of [...CATS, ...DOGS]) {
    const rows: string[] = []
    for (const scene of scenes) {
      const said = await $.command.run({ command: 'petdex', args: `預覽 ${scene} ${name}` } as never)
      expect(said.text).toContain('預覽「')
      const drawn = await band($)
      expect(drawn).toContain(name)
      expect(drawn).toContain('（預覽中）')
      if (scene === '深夜') expect(drawn).toContain('zZ')
      if (scene === '散步') expect(lineOf(drawn)).toContain('52 分鐘')
      if (scene.startsWith('肚子')) expect(drawn).toContain(`肚子 ${cells[scene]} ${scene.slice(3)}%`)
      if (scene === '吐') expect(drawn).toContain('剛吐完')
      rows.push(`${scene.padEnd(5, '　')} ${drawn.split(' 5h ')[0]}`)
    }
    console.log(rows.join('\n'))
  }
  // The scenes that pop a toast for real pop it in the preview too, marked as one.
  const previews = w.shown.filter(text => text.startsWith('【預覽】'))
  expect(previews.length).toBe((CATS.length + DOGS.length) * 5)
  console.log(previews.slice(0, 10).join('\n'))
})

// A conversation as the next request sends it: a big file read twice, a file written whole, a long log, a screenshot.
const MEALS = [
  { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nCLAUDE.md\n</system-reminder>' }, { type: 'text', text: '幫我看 build 為什麼壞掉' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'D:\\proj\\package-lock.json' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x'.repeat(140_000) }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'D:\\proj\\src\\app.ts', content: 'y'.repeat(35_000) } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'File created successfully' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'PowerShell', input: { command: 'git log -p -5' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: [{ type: 'text', text: 'z'.repeat(21_000) }] }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'D:\\proj\\package-lock.json', offset: 9 } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: 'x'.repeat(14_000) }] },
  { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
]

test("/petdex 肚子 lists the biggest meals in the belly, and the pet blames the biggest when it is about to burst", { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(10, 20))
  w.messages = MEALS
  w.categories = [
    { name: 'System prompt', tokens: 3100, kind: 'used' },
    { name: 'System tools', tokens: 17_000, kind: 'used' },
    { name: 'Messages', tokens: 62_000, kind: 'used' },
    { name: 'Free space', tokens: 85_000, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
  ]
  await $.session.start(START)
  await clock.advance(1000)
  await eat($, w, 82_000)

  const said = (await $.command.run({ command: 'petdex', args: '肚子' } as never)).text
  const lines = said.split('\n')
  expect(lines[0]).toContain('的肚子 ●●●○○ context 41%（≈82k / 200k，吃到 ≈160k 會吐（自動壓縮））')
  expect(said).toContain('吃最多的前 4 名：')
  expect(lines.find(line => line.startsWith(' 1.'))).toBe(' 1. ≈44k   Read package-lock.json ×2')
  expect(lines.find(line => line.startsWith(' 2.'))).toContain('Write src/app.ts（寫進去的內容）')
  expect(lines.find(line => line.startsWith(' 3.'))).toContain('≈6k    PowerShell git log -p -5')
  expect(lines.find(line => line.startsWith(' 4.'))).toContain('你貼的圖片')
  expect(said).toContain('肚子裡的分類：系統提示 ≈3k｜內建工具 ≈17k｜對話 ≈62k')
  expect(said).not.toContain('Free space')
  // The pet names the biggest meal; not yet full enough to ask for a /compact.
  expect(lineOf(said)).toContain('package-lock.json（≈44k）')
  expect(lineOf(said)).not.toContain('/compact')
  console.log(said)

  // About to burst: the toast says what the biggest meal was.
  await eat($, w, 150_000)
  expect(w.shown.filter(text => text.includes('肚子快撐爆了'))).toHaveLength(1)
  expect(w.shown.some(text => text.includes('最大的一口：Read package-lock.json（≈44k），/petdex 肚子 看全部'))).toBe(true)
  expect(lineOf((await $.command.run({ command: 'petdex', args: 'belly' } as never)).text)).toContain('/compact')
  console.log(w.shown.join('\n'))
})

test('/petdex 肚子 before any reply and with nothing big eaten yet', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(10, 20))
  w.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  await $.session.start(START)

  const said = (await $.command.run({ command: 'petdex', args: '肚子' } as never)).text
  expect(said).toContain('還沒有回覆報過 context')
  expect(said).toContain('肚子裡還沒有什麼大餐')
  expect(said).not.toContain('「')
})

test('on the desktop the band folds to one line and back, and stays folded in the next session', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  world(on, limits(66, 46))
  await $.session.start(START)

  const terminal = await $.ui.mount({ plugin: 'quota-pets', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS as never })
  expect(await terminal.find({ key: 'fold' })).toBeUndefined()
  await terminal.unmount()

  const ui = await $.ui.mount({ plugin: 'quota-pets', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS as never })
  expect(textOf(await ui.drawn())).toContain('飼料(週)')
  await ui.press({ key: 'fold' })
  const folded = textOf(await ui.drawn())
  expect(folded).toContain('5h 66%')
  expect(folded).not.toContain('飼料(週)')
  expect(folded).not.toContain('「')
  expect(await ui.find({ key: 'unfold' })).toBeDefined()
  await ui.unmount()

  // A new session (a hot reload alike) finds it folded.
  await $.session.start(START)
  expect(await band($, 'desktop')).not.toContain('飼料(週)')
  const again = await $.ui.mount({ plugin: 'quota-pets', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS as never })
  await again.press({ key: 'unfold' })
  expect(textOf(await again.drawn())).toContain('飼料(週)')
  await again.unmount()
})

test('what other plugins draw in the band stays, beside the pet', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, limits(10, 20))
  w.beneath = '對話 diff · 這個對話改了 2 個檔案 +5 -1'
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await band($, surface)
    expect(drawn).toContain('這個對話改了 2 個檔案')
    expect(drawn.indexOf('5h')).toBeLessThan(drawn.indexOf('對話 diff'))
  }
})

// $.store as the engine keeps it: one file every session reads afresh, so another session's write shows at once.
function sharedStore(on: On, entries: Record<string, unknown>): Map<string, unknown> {
  const store = new Map(Object.entries(entries))
  on('store.get', ($, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    store.delete((e as { key: string }).key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  return store
}

test('a conversation shows the quota other conversations read, opened new or come back to', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // An earlier session read this half an hour ago; the week it saw has restocked since.
  const store = sharedStore(on, {
    limits: { five: { pct: 58, resetsAt: NOW + 2 * HOUR }, week: { pct: 90, resetsAt: NOW - HOUR }, at: NOW - 30 * MINUTE },
  })
  const w = world(on, [])
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await band($, surface)
    expect(drawn).toContain('58%')
    expect(drawn).not.toContain('飼料(週)')
    expect(drawn).not.toContain('還沒拿到額度資料')
  }

  // Another conversation gets an answer: this one takes its reading up within seconds, nobody saying a word here.
  store.set('limits', { five: { pct: 41, resetsAt: NOW + 2 * HOUR }, week: { pct: 33, resetsAt: NOW + 3 * DAY }, at: NOW + 5000 })
  await clock.advance(15_000)
  let drawn = await band($)
  expect(drawn).toContain('41%')
  expect(drawn).toContain('33%')

  // This conversation's own answer is newer still: it shows, and the others will take it up.
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await clock.advance(5000)
  w.rateLimits = limits(44, 34)
  await measure($, w.rateLimits)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5000, isAborted: false, reason: 'end_turn' } as never)
  drawn = await band($)
  expect(drawn).toContain('44%')
  expect((store.get('limits') as { five: { pct: number } }).five.pct).toBe(44)
  // An older reading in the store never takes the place of a newer one.
  store.set('limits', { five: { pct: 10, resetsAt: NOW + 2 * HOUR }, week: null, at: NOW })
  await clock.advance(15_000)
  expect(await band($)).toContain('44%')
  // The turn counted from 41%, a reading seconds old: +3 is no big bite, so no toast.
  expect(w.shown.filter(text => !text.startsWith('log:'))).toEqual([])
})

test('a conversation opened with no fresh reading asks /usage in the background, once for every session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = sharedStore(on, {})
  const w = world(on, [])
  const reset = new Date(NOW + 2 * HOUR)
  const time = (date: Date) => `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}${date.getHours() < 12 ? 'am' : 'pm'}`
  w.usage = [
    'Current session: 37% used · resets ' + time(reset),
    'Current week (all models): 20% used · resets Oct 7, 1am',
  ].join('\n')
  await $.session.start(START)
  await clock.advance(10)

  // The probe is a `claude -p` that keeps no session and starts no MCP server, its own copy of the plugin kept still.
  expect(w.probes).toHaveLength(1)
  expect(w.probes[0]?.argv).toEqual(['claude', '-p', '--no-session-persistence', '--strict-mcp-config', '/usage'])
  expect(w.probes[0]?.env).toEqual({ QUOTA_PETS_PROBE: '1' })
  const drawn = await band($)
  expect(drawn).toContain('37%')
  expect(drawn).toContain('飼料(週)')
  expect((store.get('limits') as { five: { pct: number } }).five.pct).toBe(37)

  // Come back to within two minutes, or another session starting meanwhile: the reading is fresh, nothing is asked.
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
  await $.session.start(START)
  await clock.advance(30_000)
  expect(w.probes).toHaveLength(1)

  // Ten idle minutes later it asks again, for what claude.ai or another machine spent.
  w.usage = w.usage.replace('37%', '52%')
  await clock.advance(10 * MINUTE)
  expect(w.probes).toHaveLength(2)
  expect(await band($)).toContain('52%')
  expect(w.shown.filter(text => !text.startsWith('log:'))).toEqual([])
})

test('the claude a probe starts keeps the plugin still: no probe of its own, no command', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, [])
  on('env.get', ($, e) => ({ value: (e as { name: string }).name === 'QUOTA_PETS_PROBE' ? '1' : undefined }) as never)
  w.usage = 'Current session: 37% used'
  await $.session.start(START)
  expect(w.probes).toHaveLength(0)
  expect(w.commands).toEqual([])
})
