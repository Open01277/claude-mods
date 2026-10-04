// What `claude -p /usage` prints, read back into the quota windows. The engine hands a plugin the quota only as the
// last answer reported it; /usage asks the server, with the person's own login, which no plugin ever touches.
//
//   Current session: 16% used · resets Oct 5, 3:10am (Asia/Taipei)
//   Current week (all models): 54% used · resets Oct 7, 1am (Asia/Taipei)

import type { QuotaPetsLimit } from '../types'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_MS = 24 * 3600_000

// The reset as the machine's own clock reads it: /usage prints it in the machine's time zone, with no year (and, for
// a reset later today, perhaps no date). The nearest such moment from a little before now on is the one meant.
export function resetOf(text: string, now: number): number | null {
  const match = /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(text)
  if (match === null) return null
  const [, month, day, hour = '', minute = '0', half = ''] = match
  const h = (Number(hour) % 12) + (half.toLowerCase() === 'pm' ? 12 : 0)
  const m = Number(minute)
  const today = new Date(now)
  const candidates: number[] = []
  if (month === undefined || day === undefined) {
    for (const add of [0, 1]) {
      candidates.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() + add, h, m).getTime())
    }
  } else {
    const index = MONTHS.indexOf(month.toLowerCase())
    if (index < 0) return null
    for (const year of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
      candidates.push(new Date(year, index, Number(day), h, m).getTime())
    }
  }
  const ahead = candidates.filter(at => at > now - 3600_000 && at - now < 8 * DAY_MS).sort((x, y) => x - y)
  return ahead[0] ?? null
}

function windowOf(lines: readonly string[], label: RegExp, now: number): QuotaPetsLimit | null {
  const line = lines.find(one => label.test(one))
  if (line === undefined) return null
  const pct = /(\d+(?:\.\d+)?)\s*%\s*used/i.exec(line)
  if (pct === null) return null
  return { pct: Number(pct[1]), resetsAt: resetOf(line, now) }
}

// The 5-hour and weekly windows, or null when the text holds neither (off a subscription, or a format it no longer
// has: the band then waits for an answer, as it always did).
export function parseUsage(text: string, now: number): { five: QuotaPetsLimit | null; week: QuotaPetsLimit | null } | null {
  const lines = text.split(/\r?\n/)
  const five = windowOf(lines, /^\s*current session\b/i, now)
  const week = windowOf(lines, /^\s*current week \(all models\)/i, now)
  return five === null && week === null ? null : { five, week }
}
