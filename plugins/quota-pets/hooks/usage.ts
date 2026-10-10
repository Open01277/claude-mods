// The quota and whose it is, as the server answers this session's own login: the answers the usage panel reads.
// Neither path is a documented API, so an answer in any other shape reads as none, and the band waits for one.
//
//   GET /api/oauth/usage    { five_hour: { utilization: 13, resets_at: "2026-10-07T20:00:00+00:00" }, seven_day: ...,
//                             cedar_ember: { eligible, grants: [{ id, resets_left, ends_at, clears, ... }] } }
//   GET /api/oauth/profile  { account: { uuid }, organization: { uuid }, ... }
//
// The free resets (`cedar_ember`) ride along only when asked for, as Claude Code's own reset check asks for them;
// `skip_spend=1` leaves out the spend, which the band never shows.

import type { QuotaPetsCoupons, QuotaPetsGrant, QuotaPetsLimit } from '../types'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
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

function timeOf(value: unknown): number | null {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(at) ? at : null
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function windowOf(value: unknown): QuotaPetsLimit | null {
  const pct = field(value, 'utilization')
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null
  return { pct, resetsAt: timeOf(field(value, 'resets_at')) }
}

// The 5-hour and weekly windows, or null when the answer holds neither (off a subscription, or a shape it no longer has).
export function usageOf(text: string): { five: QuotaPetsLimit | null; week: QuotaPetsLimit | null } | null {
  const json = parse(text)
  const five = windowOf(field(json, 'five_hour'))
  const week = windowOf(field(json, 'seven_day'))
  return five === null && week === null ? null : { five, week }
}

// One grant, or null when it lacks its id or how many it has left. One that does not say whether it needs a limit
// is taken as one that does, as Claude Code takes it.
function grantOf(value: unknown): QuotaPetsGrant | null {
  const id = field(value, 'id')
  const left = countOf(field(value, 'resets_left'))
  if (typeof id !== 'string' || id === '' || left === null) return null
  const label = field(value, 'label')
  const total = countOf(field(value, 'resets_total'))
  const clears = field(value, 'clears')
  return {
    id,
    label: typeof label === 'string' ? label : '',
    left,
    total: total === null || total < left ? left : total,
    startsAt: timeOf(field(value, 'starts_at')),
    endsAt: timeOf(field(value, 'ends_at')),
    clears: Array.isArray(clears) ? clears.filter((kind): kind is string => typeof kind === 'string') : [],
    isPaused: field(value, 'paused') === true,
    needsLimit: field(value, 'use_requires_limit') !== false,
  }
}

// The free resets the answer lists: none when it holds no such block.
export function couponsOf(text: string): Omit<QuotaPetsCoupons, 'at'> {
  const block = field(parse(text), 'cedar_ember')
  const grants = field(block, 'grants')
  const eligible = field(block, 'eligible')
  const reason = field(block, 'ineligible_reason')
  return {
    grants: Array.isArray(grants) ? grants.map(grantOf).filter((grant): grant is QuotaPetsGrant => grant !== null) : [],
    eligible: typeof eligible === 'boolean' ? eligible : null,
    reason: typeof reason === 'string' ? reason : null,
  }
}

// The account and the organization it spends in: one quota each, so readings are kept apart by both.
export function accountOf(text: string): string | null {
  const json = parse(text)
  const account = field(field(json, 'account'), 'uuid')
  const org = field(field(json, 'organization'), 'uuid')
  return typeof account === 'string' && account !== '' && typeof org === 'string' && org !== '' ? `${account}/${org}` : null
}
