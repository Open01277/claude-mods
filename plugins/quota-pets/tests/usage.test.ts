import { expect, test } from 'claude-code/testing'

import { parseUsage, resetOf } from '../hooks/usage'

// Local time, as /usage prints it in the machine's own zone.
const NOW = new Date(2026, 9, 4, 20, 0).getTime()

const TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 16% used · resets Oct 5, 3:10am (Asia/Taipei)',
  'Current week (all models): 54% used · resets Oct 7, 1am (Asia/Taipei)',
  '',
  "What's contributing to your limits usage?",
].join('\n')

test('/usage reads back into the 5-hour and weekly windows, resets in local time', () => {
  expect(parseUsage(TEXT, NOW)).toEqual({
    five: { pct: 16, resetsAt: new Date(2026, 9, 5, 3, 10).getTime() },
    week: { pct: 54, resetsAt: new Date(2026, 9, 7, 1, 0).getTime() },
  })
})

test('a reset with no date is the next such time, and one across new year falls in the next year', () => {
  expect(resetOf('resets 11:30pm', NOW)).toBe(new Date(2026, 9, 4, 23, 30).getTime())
  expect(resetOf('resets 9am', NOW)).toBe(new Date(2026, 9, 5, 9, 0).getTime())
  const eve = new Date(2026, 11, 30, 12, 0).getTime()
  expect(resetOf('resets Jan 2, 12pm', eve)).toBe(new Date(2027, 0, 2, 12, 0).getTime())
})

test('text without the windows reads as nothing, and a window without a reset keeps its percent', () => {
  expect(parseUsage('You are using an API key.', NOW)).toBeNull()
  expect(parseUsage('Current session: 3.5% used', NOW)).toEqual({ five: { pct: 3.5, resetsAt: null }, week: null })
})
