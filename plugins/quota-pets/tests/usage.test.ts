import { expect, test } from 'claude-code/testing'

import { accountOf, usageOf } from '../hooks/usage'

test('the quota reads from the server answer, its resets in UTC', () => {
  const text = JSON.stringify({
    five_hour: { utilization: 13, resets_at: '2026-10-07T20:00:00.049651+00:00', limit_dollars: null },
    seven_day: { utilization: 48, resets_at: '2026-10-10T12:00:00.049671+00:00' },
    seven_day_opus: null,
  })
  expect(usageOf(text)).toEqual({
    five: { pct: 13, resetsAt: Date.UTC(2026, 9, 7, 20, 0, 0, 49) },
    week: { pct: 48, resetsAt: Date.UTC(2026, 9, 10, 12, 0, 0, 49) },
  })
})

test('an answer in another shape reads as none, a window without its reset keeps its percent', () => {
  expect(usageOf('<html>Service Unavailable</html>')).toBeNull()
  expect(usageOf(JSON.stringify({ five_hour: null, seven_day: null }))).toBeNull()
  expect(usageOf(JSON.stringify({ five_hour: { utilization: 3.5, resets_at: null } }))).toEqual({
    five: { pct: 3.5, resetsAt: null },
    week: null,
  })
})

test('whose quota: the account and the organization it spends in, both or none', () => {
  expect(accountOf(JSON.stringify({ account: { uuid: 'a' }, organization: { uuid: 'o' } }))).toBe('a/o')
  expect(accountOf(JSON.stringify({ account: { uuid: 'a' } }))).toBeNull()
  expect(accountOf('not json')).toBeNull()
})
