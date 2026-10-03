export type QuotaPetsLimit = { pct: number; resetsAt: number | null }

export type QuotaPetsLimits = {
  five: QuotaPetsLimit | null
  week: QuotaPetsLimit | null
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

export type QuotaPetsPreview = { pct: number; until: number; petId: string | null }

declare module 'claude-code' {
  interface PluginState {
    'quota-pets': {
      limits: QuotaPetsLimits | null
      pet: QuotaPetsLife | null
      preview: QuotaPetsPreview | null
    }
  }
}
