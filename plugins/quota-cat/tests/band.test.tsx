import { expect, mock, test } from 'claude-code/testing'
import type { RenderElement, SessionRateLimit } from 'claude-code'

const NOW = Date.parse('2026-10-03T10:00:00Z')
const HOUR = 3600_000

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

test('the band follows the quota from calm to dead to reborn', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts: string[] = []
  let current = limits(12, 20)

  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.measure', ($, e) => ({ changed: (e as { changed: string[] }).changed }) as never)
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.log', ($, e) => {
    toasts.push(`log: ${(e as { text: string }).text}`)
    return { value: undefined } as never
  })
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: current } }) as never)
  on('ui.toast', ($, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)

  const draws: string[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'quota-cat',
      surface,
      component: 'AbovePrompt',
      props: BAND_PROPS as never,
    })
    draws.push(textOf(await ui.drawn()))
  }
  for (const drawn of draws) {
    expect(drawn).toContain('普通貓')
    expect(drawn).toContain('12%')
    expect(drawn).toContain('貓糧(週)')
  }
  expect(toasts.some(text => text.includes('新手禮包'))).toBe(true)

  for (const pct of [45, 70, 87, 92, 96, 99.5, 100]) {
    current = limits(pct, 40)
    await $.session.measure({ context: { window: 200_000 }, rateLimits: current, changed: ['rateLimits'] } as never)
    const ui = await $.ui.mount({ plugin: 'quota-cat', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS as never })
    const drawn = textOf(await ui.drawn())
    expect(drawn).toContain(`${Math.floor(pct)}%`)
    console.log(`${pct}% → ${drawn}`)
  }
  expect(toasts.some(text => text.includes('陣亡'))).toBe(true)

  await clock.advance(3 * HOUR)
  current = limits(3, 41, NOW + 8 * HOUR)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: current, changed: ['rateLimits'] } as never)
  expect(toasts.some(text => text.includes('轉生成'))).toBe(true)
  console.log(toasts.join('\n'))

  const dex = await $.command.run({ command: 'catdex', args: '' } as never)
  expect(dex.text).toContain('貓咪圖鑑')
  console.log(dex.text)
  const ten = await $.command.run({ command: 'catdex', args: '十連' } as never)
  console.log(ten.text)
})
