// The quota and whose it is, as the server answers this session's own login: the answers the usage panel reads.
// Neither path is a documented API, so an answer in any other shape reads as none, and the band waits for one.
//
//   GET /api/oauth/usage    { five_hour: { utilization: 13, resets_at: "2026-10-07T20:00:00+00:00" }, seven_day: ... }
//   GET /api/oauth/profile  { account: { uuid }, organization: { uuid }, ... }

import type { QuotaPetsLimit } from '../types'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const OAUTH_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' }

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}

function windowOf(value: unknown): QuotaPetsLimit | null {
  const pct = field(value, 'utilization')
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null
  const resets = field(value, 'resets_at')
  const at = typeof resets === 'string' ? Date.parse(resets) : Number.NaN
  return { pct, resetsAt: Number.isFinite(at) ? at : null }
}

// The 5-hour and weekly windows, or null when the answer holds neither (off a subscription, or a shape it no longer has).
export function usageOf(text: string): { five: QuotaPetsLimit | null; week: QuotaPetsLimit | null } | null {
  const json = parse(text)
  const five = windowOf(field(json, 'five_hour'))
  const week = windowOf(field(json, 'seven_day'))
  return five === null && week === null ? null : { five, week }
}

// The account and the organization it spends in: one quota each, so readings are kept apart by both.
export function accountOf(text: string): string | null {
  const json = parse(text)
  const account = field(field(json, 'account'), 'uuid')
  const org = field(field(json, 'organization'), 'uuid')
  return typeof account === 'string' && account !== '' && typeof org === 'string' && org !== '' ? `${account}/${org}` : null
}
