export type QuotaPetsLimit = { pct: number; resetsAt: number | null }

export type QuotaPetsLimits = {
  five: QuotaPetsLimit | null
  week: QuotaPetsLimit | null
  // When the reading came, in this session or another: every session leaves its latest in $.store and takes up a
  // newer one from there, so a conversation shows what another one just read.
  at?: number
}

// A free reset of the quota the account was given (the server's `cedar_ember` grants): how many are left, the time
// it can be pressed in, which limits it empties (`five_hour`, `seven_day`, ...), and whether it works only at a limit.
export type QuotaPetsGrant = {
  id: string
  label: string
  left: number
  total: number
  startsAt: number | null
  endsAt: number | null
  clears: string[]
  isPaused: boolean
  needsLimit: boolean
}

// The account's free resets as the server last answered, and when: kept in $.store like the quota, so every
// conversation of the account shows them. `eligible` and `reason` as the server said them, for /petdex 券.
export type QuotaPetsCoupons = {
  grants: QuotaPetsGrant[]
  eligible: boolean | null
  reason: string | null
  at: number
}

// One conversation's pet: pulled when the conversation starts, re-pulled on each 5-hour reset.
export type QuotaPetsLife = {
  conv: number
  id: string
  since: number
  isDead: boolean
  window: number | null
  lastPct: number | null
  warned: number
}

// What /petdex 預覽 acts out besides the quota: a night, a walk, a belly, a compaction or a free reset in hand.
export type QuotaPetsScene = 'night' | 'walk' | 'back' | 'belly' | 'burp' | 'slim' | 'coupon'

export type QuotaPetsPreview = {
  pct: number
  until: number
  petId: string | null
  scene?: QuotaPetsScene | null
  belly?: number | null
}

// The last compaction: `isAuto` when the engine did it at its threshold, token counts when core recorded them.
export type QuotaPetsCompaction = { at: number; isAuto: boolean; before: number | null; after: number | null }

// The context window as the pet's belly: full when auto-compaction is about to run.
export type QuotaPetsBelly = {
  conv: number
  tokens: number | null
  pct: number | null
  window: number
  // The token count auto-compaction runs at; null when it is off or unknown.
  threshold: number | null
  warned: boolean
  compacted: QuotaPetsCompaction | null
}

// This session's run of work: when it began, its last sign of life, the walk reminders it got.
export type QuotaPetsActivity = {
  since: number
  last: number
  nags: number
  // When work resumed after a break the pet had asked for.
  back: number | null
  // The night (its local date) the pet last said goodnight.
  night: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'quota-pets': {
      limits: QuotaPetsLimits | null
      coupons: QuotaPetsCoupons | null
      pet: QuotaPetsLife | null
      preview: QuotaPetsPreview | null
      belly: QuotaPetsBelly | null
      activity: QuotaPetsActivity | null
      // The band folded to one line, on the desktop; kept in $.store across sessions.
      folded: boolean
      // A /usage probe is out: the band says the quota is on its way.
      probing: boolean
    }
  }
}
