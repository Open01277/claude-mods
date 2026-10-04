// One file this conversation changed: what it held before the conversation first touched it.
export type ConvoDiffBase = {
  key: string
  path: string
  // null: the file did not exist yet.
  base: string | null
  // The content before could not be kept (too large, unreadable, or dropped from the store).
  isLost: boolean
  seq: number
  // HEAD when the conversation first changed the file: '' with no commit yet, null or absent when unknown (a file
  // read back from the transcript, or kept by an older version). A commit since that took the file moves its base.
  head?: string | null
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
  // Compared with a commit that took this conversation's changes to it, not with the file before the conversation.
  isCommitted: boolean
}

export type ConvoDiffView = {
  conv: number
  at: number
  // What is not committed yet: each file against the last commit that took it, else its base.
  files: ConvoDiffFile[]
  // The whole conversation: each file against its base, commits or not.
  all: ConvoDiffFile[]
}

// The person's expand/collapse choices in the pane, by file key.
export type ConvoDiffOpen = {
  conv: number
  keys: Record<string, boolean>
  // The pane shows the whole conversation, to read only, instead of what is not committed yet.
  isAll?: boolean
}

// What a revert did to one file: its text just before (null: there was no file) and what the revert left (null: removed).
export type ConvoDiffUndo = {
  before: string | null
  after: string | null
}

export type ConvoDiffReverts = {
  conv: number
  // The file whose revert waits for a yes.
  confirm: string | null
  undo: Record<string, ConvoDiffUndo>
}

declare module 'claude-code' {
  interface PluginState {
    'convo-diff': {
      track: ConvoDiffTrack | null
      view: ConvoDiffView | null
      open: ConvoDiffOpen | null
      revert: ConvoDiffReverts | null
    }
  }
}
