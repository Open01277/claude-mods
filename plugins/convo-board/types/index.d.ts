// Where a conversation stands, as it tells every other conversation's board.
export type ConvoBoardPhase = 'idle' | 'running' | 'waiting' | 'done'

// How the last turn ended: answered, stopped on an error, or cut off when its conversation stopped mid-turn.
export type ConvoBoardOutcome = 'answered' | 'failed' | 'cut'

// Who this conversation is: the desktop's session, or the transcript where no desktop runs it.
export type ConvoBoardMe = {
  // The desktop's session id (`local_…`), else the transcript's id.
  id: string
  title: string | null
  cwd: string
  // The desktop's claude:// link to the conversation; null where there is none.
  link: string | null
  isDesktop: boolean
}

// One conversation's line in the store: written by that conversation alone, read by every board.
export type ConvoBoardEntry = {
  v: 1
  id: string
  title: string | null
  cwd: string
  link: string | null
  isDesktop: boolean
  phase: ConvoBoardPhase
  // When the phase began: the turn's start while running, the dialog while waiting, the end once done.
  since: number
  // When the turn began, kept while it waits; null between turns.
  turnAt: number | null
  // The prompt the turn works on, its first line.
  ask: string | null
  // Running: the tool in hand, or the last one done; waiting: what the dialog asks.
  doing: string | null
  // A tool is in hand right now.
  isBusy: boolean
  // The last turn's final answer, cut to fit.
  answer: string | null
  // Null before any turn ended.
  outcome: ConvoBoardOutcome | null
  // The person saw the last turn end, or opened the conversation since.
  isSeen: boolean
  // The conversation's last sign of life.
  beat: number
}

// What the desktop's own list says of a conversation.
export type ConvoBoardSession = {
  id: string
  title: string
  cwd: string
  link: string | null
  isRunning: boolean
}

export type ConvoBoardSection = 'waiting' | 'unseen' | 'running'

// One row of the board, ready to draw.
export type ConvoBoardRow = {
  id: string
  section: ConvoBoardSection
  title: string
  folder: string
  link: string | null
  isDesktop: boolean
  // The line under the title: what it asks, what it does, or how it ended.
  detail: string
  // The prompt the turn works on, for a running or waiting row.
  ask: string | null
  // How long it has waited or run, or how long ago it ended.
  time: string
  // The final answer, to unfold on the board.
  answer: string | null
  isError: boolean
  // The answer ends on a question to the person.
  asksBack: boolean
}

export type ConvoBoardView = {
  rows: ConvoBoardRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'convo-board': {
      me: ConvoBoardMe | null
      entry: ConvoBoardEntry | null
      view: ConvoBoardView | null
      // The rows whose answer is unfolded, by conversation id.
      open: Record<string, boolean>
    }
  }
}
