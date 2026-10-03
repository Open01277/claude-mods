export type QuotaCatLimit = { pct: number; resetsAt: number | null }

export type QuotaCatLimits = {
  five: QuotaCatLimit | null
  week: QuotaCatLimit | null
}

export type QuotaCatNow = { id: string; since: number; isDead: boolean }

export type QuotaCatPreview = { pct: number; until: number; catId: string | null }

declare module 'claude-code' {
  interface PluginState {
    'quota-cat': {
      limits: QuotaCatLimits | null
      cat: QuotaCatNow | null
      preview: QuotaCatPreview | null
    }
  }
}
