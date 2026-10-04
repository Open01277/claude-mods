// One file this conversation changed: what it held before the conversation first touched it.
export type ConvoDiffBase = {
  key: string
  path: string
  // null: the file did not exist yet.
  base: string | null
  // The content before could not be kept (too large, unreadable, or dropped from the store).
  isLost: boolean
  seq: number
}

// Keyed by the conversation's start (`$.session.usage().startedAt`), which a /clear moves.
export type ConvoDiffTrack = {
  conv: number
  seq: number
  files: ConvoDiffBase[]
}

export type ConvoDiffStatus = 'added' | 'modified' | 'deleted' | 'same' | 'lost'

// One file as the pane draws it: the net change from its base to what is on disk now.
export type ConvoDiffFile = {
  key: string
  path: string
  rel: string
  status: ConvoDiffStatus
  isBinary: boolean
  added: number
  removed: number
  // Unified-diff hunks, each short enough for one <Code format="diff">.
  chunks: string[]
  hiddenLines: number
  note: string | null
  seq: number
}

export type ConvoDiffView = {
  conv: number
  at: number
  files: ConvoDiffFile[]
}

// The person's expand/collapse choices in the pane, by file key.
export type ConvoDiffOpen = {
  conv: number
  keys: Record<string, boolean>
}

declare module 'claude-code' {
  interface PluginState {
    'convo-diff': {
      track: ConvoDiffTrack | null
      view: ConvoDiffView | null
      open: ConvoDiffOpen | null
    }
  }
}
