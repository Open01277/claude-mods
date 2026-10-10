import { expect, test } from 'claude-code/testing'

import { USAGE_URL, accountOf, couponsOf, usageOf } from '../hooks/usage'

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

test('the free resets ride along with the quota when asked for, as Claude Code asks for them', () => {
  expect(new URL(USAGE_URL).searchParams.get('cedar_ember')).toBe('1')
  const text = JSON.stringify({
    five_hour: { utilization: 13, resets_at: null },
    cedar_ember: {
      eligible: true,
      ineligible_reason: null,
      next_grant_id: 'opus-launch',
      grants: [
        {
          id: 'opus-launch',
          label: 'Opus 5.5 launch',
          resets_total: 1,
          resets_left: 1,
          starts_at: '2026-09-22T00:00:00+00:00',
          ends_at: '2026-10-22T06:59:59.000+00:00',
          clears: ['five_hour', 'seven_day', 42],
          paused: false,
          usable_now: false,
          percent_used: { seven_day: 13 },
          blocking: [],
        },
        // No count of what is left: not a grant to show.
        { id: 'broken', ends_at: '2026-10-30T00:00:00+00:00' },
        { id: 'anytime', resets_left: 2, use_requires_limit: false },
      ],
    },
  })
  expect(couponsOf(text)).toEqual({
    eligible: true,
    reason: null,
    grants: [
      {
        id: 'opus-launch',
        label: 'Opus 5.5 launch',
        left: 1,
        total: 1,
        startsAt: Date.UTC(2026, 8, 22),
        endsAt: Date.UTC(2026, 9, 22, 6, 59, 59),
        clears: ['five_hour', 'seven_day'],
        isPaused: false,
        // Not said: taken as a reset for a limit only, as Claude Code takes it.
        needsLimit: true,
      },
      { id: 'anytime', label: '', left: 2, total: 2, startsAt: null, endsAt: null, clears: [], isPaused: false, needsLimit: false },
    ],
  })
})

test('an answer with no resets in it, or none to give, holds none', () => {
  expect(couponsOf(JSON.stringify({ five_hour: null, cedar_ember: null }))).toEqual({ grants: [], eligible: null, reason: null })
  expect(couponsOf(JSON.stringify({ cedar_ember: { eligible: false, ineligible_reason: 'no_grant' } }))).toEqual({
    grants: [],
    eligible: false,
    reason: 'no_grant',
  })
  expect(couponsOf('<html>Service Unavailable</html>')).toEqual({ grants: [], eligible: null, reason: null })
})

test('whose quota: the account and the organization it spends in, both or none', () => {
  expect(accountOf(JSON.stringify({ account: { uuid: 'a' }, organization: { uuid: 'o' } }))).toBe('a/o')
  expect(accountOf(JSON.stringify({ account: { uuid: 'a' } }))).toBeNull()
  expect(accountOf('not json')).toBeNull()
})
