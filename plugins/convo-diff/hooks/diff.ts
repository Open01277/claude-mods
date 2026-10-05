// Line diffs with no dependencies: Myers' O(ND) over the lines both sides do not share at the ends.

export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: readonly string[]
}

export type Diff = {
  added: number
  removed: number
  // Unified-diff hunks, each at most `chunk` characters, so each fits one <Code format="diff">.
  chunks: string[]
  hiddenLines: number
}

export type DiffLimits = {
  context: number
  chunk: number
  perFile: number
  lineChars: number
}

export const LIMITS: DiffLimits = { context: 3, chunk: 8000, perFile: 30_000, lineChars: 1000 }

const SAME = 0
const DEL = 1
const ADD = 2
type Op = { kind: typeof SAME | typeof DEL | typeof ADD; text: string }

const MAX_D = 2000
const MAX_STEPS = 20_000_000
const MAX_MIDDLE = 40_000

// Lines without their CR; a final newline leaves no empty last line.
export function splitLines(text: string): { lines: string[]; hasFinalEol: boolean } {
  if (text === '') return { lines: [], hasFinalEol: false }
  const lines = text.split('\n')
  const hasFinalEol = lines[lines.length - 1] === ''
  if (hasFinalEol) lines.pop()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1)
  }
  return { lines, hasFinalEol }
}

export function isBinary(text: string | null): boolean {
  return text !== null && text.includes('\u0000')
}

// <Code> takes tab and newline as its only control characters: the rest are drawn as their pictures.
export function printable(line: string): string {
  return line.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, char => {
    const code = char.charCodeAt(0)
    if (code < 0x20) return String.fromCharCode(0x2400 + code)
    return code === 0x7f ? '␡' : '�'
  })
}

function clip(line: string, max: number): string {
  if (line.length <= max) return line
  let cut = max
  const before = line.charCodeAt(cut - 1)
  if (before >= 0xd800 && before <= 0xdbff) cut -= 1
  return `${line.slice(0, cut)}…`
}

// The edit script for two arrays of interned lines, or null past the budget.
function myers(a: Int32Array, b: Int32Array): (typeof SAME | typeof DEL | typeof ADD)[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let steps = 0
  let found = -1

  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_D) return null
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number))
          ? (v[off + k + 1] as number)
          : (v[off + k - 1] as number) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
        steps++
      }
      steps++
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
    if (steps > MAX_STEPS) return null
    trace.push(v.slice(off - d, off + d + 1))
  }

  const script: (typeof SAME | typeof DEL | typeof ADD)[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array
    const at = (k: number) => prev[k + d - 1] as number
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      script.push(SAME)
      x--
      y--
    }
    script.push(x === prevX ? ADD : DEL)
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    script.push(SAME)
    x--
    y--
  }
  return script.reverse()
}

function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const ops: Op[] = []
  for (let i = 0; i < start; i++) ops.push({ kind: SAME, text: a[i] as string })

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  let script: (typeof SAME | typeof DEL | typeof ADD)[] | null = null
  if (midA.length > 0 && midB.length > 0 && midA.length + midB.length <= MAX_MIDDLE) {
    const ids = new Map<string, number>()
    const intern = (lines: readonly string[]) => {
      const out = new Int32Array(lines.length)
      lines.forEach((line, i) => {
        let id = ids.get(line)
        if (id === undefined) {
          id = ids.size
          ids.set(line, id)
        }
        out[i] = id
      })
      return out
    }
    script = myers(intern(midA), intern(midB))
  }
  if (script === null) {
    // Too far apart to align (or one side empty): the whole middle is replaced.
    for (const text of midA) ops.push({ kind: DEL, text })
    for (const text of midB) ops.push({ kind: ADD, text })
  } else {
    let i = 0
    let j = 0
    for (const kind of script) {
      if (kind === SAME) {
        ops.push({ kind, text: midA[i] as string })
        i++
        j++
      } else if (kind === DEL) {
        ops.push({ kind, text: midA[i] as string })
        i++
      } else {
        ops.push({ kind, text: midB[j] as string })
        j++
      }
    }
  }

  for (let i = endA; i < a.length; i++) ops.push({ kind: SAME, text: a[i] as string })
  return ops
}

// Changed runs with `context` lines around them, runs closer than twice that merged into one.
function groups(ops: readonly Op[], context: number): [number, number][] {
  const out: [number, number][] = []
  let i = 0
  while (i < ops.length) {
    if ((ops[i] as Op).kind === SAME) {
      i++
      continue
    }
    let end = i
    while (end < ops.length) {
      if ((ops[end] as Op).kind !== SAME) {
        end++
        continue
      }
      let next = end
      while (next < ops.length && (ops[next] as Op).kind === SAME) next++
      if (next < ops.length && next - end <= 2 * context) end = next
      else break
    }
    out.push([Math.max(0, i - context), Math.min(ops.length, end + context)])
    i = end
  }
  return out
}

const MARK = [' ', '-', '+'] as const

export function diffText(before: string | null, after: string | null, limits: DiffLimits = LIMITS): Diff {
  const a = before === null ? [] : splitLines(before).lines
  const b = after === null ? [] : splitLines(after).lines
  const ops = diffOps(a, b)

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.kind === ADD) added++
    else if (op.kind === DEL) removed++
  }

  // The line numbers each op starts at, on both sides.
  const oldAt = new Int32Array(ops.length + 1)
  const newAt = new Int32Array(ops.length + 1)
  let oldNext = 1
  let newNext = 1
  ops.forEach((op, i) => {
    oldAt[i] = oldNext
    newAt[i] = newNext
    if (op.kind !== ADD) oldNext++
    if (op.kind !== DEL) newNext++
  })

  const chunks: string[] = []
  let used = 0
  let hiddenLines = 0
  let lines: string[] = []
  let size = 0
  let from = -1
  let oldCount = 0
  let newCount = 0

  const close = () => {
    if (lines.length === 0) return
    const os = oldCount === 0 ? (oldAt[from] as number) - 1 : (oldAt[from] as number)
    const ns = newCount === 0 ? (newAt[from] as number) - 1 : (newAt[from] as number)
    const header = `@@ -${os},${oldCount} +${ns},${newCount} @@`
    const text = `${header}\n${lines.join('\n')}`
    const last = chunks[chunks.length - 1]
    if (last !== undefined && last.length + 1 + text.length <= limits.chunk) chunks[chunks.length - 1] = `${last}\n${text}`
    else chunks.push(text)
    used += text.length + 1
    lines = []
    size = 0
    oldCount = 0
    newCount = 0
  }

  for (const [start, end] of groups(ops, limits.context)) {
    from = start
    for (let i = start; i < end; i++) {
      const op = ops[i] as Op
      const line = `${MARK[op.kind]}${printable(clip(op.text, limits.lineChars))}`
      if (used + size + line.length + 64 > limits.perFile) {
        hiddenLines += end - i
        continue
      }
      if (size + line.length + 64 > limits.chunk) {
        close()
        from = i
      }
      lines.push(line)
      size += line.length + 1
      if (op.kind !== ADD) oldCount++
      if (op.kind !== DEL) newCount++
    }
    close()
  }

  return { added, removed, chunks, hiddenLines }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// One diff line, with the line number it starts at on each side.
type Row = { text: string; old: number; new: number }

// A run of a hunk's rows as a hunk of its own: a header counted from them.
function hunkOf(rows: readonly Row[]): string {
  const first = rows[0] as Row
  const oldCount = rows.filter(row => !row.text.startsWith('+')).length
  const newCount = rows.filter(row => !row.text.startsWith('-')).length
  const os = oldCount === 0 ? first.old - 1 : first.old
  const ns = newCount === 0 ? first.new - 1 : first.new
  return `@@ -${os},${oldCount} +${ns},${newCount} @@\n${rows.map(row => row.text).join('\n')}`
}

// A file's chunks cut again into pieces of at most `rows` lines and `chars` characters, headers counted, each a
// valid diff on its own: a hunk cut in two is two hunks.
export function piecesOf(chunks: readonly string[], rows: number, chars: number = LIMITS.chunk): string[] {
  const pieces: string[] = []
  let parts: string[] = []
  let run: Row[] = []
  let used = 0
  let size = 0
  let oldNext = 1
  let newNext = 1
  const closeRun = () => {
    if (run.length > 0) parts.push(hunkOf(run))
    run = []
  }
  const closePiece = () => {
    closeRun()
    if (parts.length > 0) pieces.push(parts.join('\n'))
    parts = []
    used = 0
    size = 0
  }
  for (const line of chunks.flatMap(chunk => chunk.split('\n'))) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      closeRun()
      oldNext = Number(header[1]) + (header[2] === '0' ? 1 : 0)
      newNext = Number(header[3]) + (header[4] === '0' ? 1 : 0)
      continue
    }
    // Room for this line, and for the header its run needs when it opens one.
    const cost = (run.length === 0 ? 1 : 0) + 1
    if (used > 0 && (used + cost > rows || size + line.length + 40 > chars)) closePiece()
    if (run.length === 0) used += 1
    run.push({ text: line, old: oldNext, new: newNext })
    used += 1
    size += line.length + 1
    if (!line.startsWith('+')) oldNext++
    if (!line.startsWith('-')) newNext++
  }
  closePiece()
  return pieces
}

// The text before a change, from the text after it and the change's hunks; null when they disagree.
export function unapply(after: string, hunks: readonly Hunk[]): string | null {
  const eol = after.includes('\r\n') ? '\r\n' : '\n'
  const split = splitLines(after)
  let lines = split.lines
  let sawOldEnd = false
  let touchesEnd: boolean | null = null

  // Last hunk first, so the earlier ones' line numbers still hold.
  const sorted = [...hunks].sort((x, y) => y.newStart - x.newStart)
  for (const hunk of sorted) {
    const oldSide: string[] = []
    const newSide: string[] = []
    let prev = ''
    for (const raw of hunk.lines) {
      // `\ No newline at end of file` speaks for the line before it.
      if (raw.startsWith('\\')) {
        if (prev === '-' || prev === ' ') sawOldEnd = true
        continue
      }
      const mark = raw.charAt(0)
      const text = raw.slice(1).replace(/\r$/, '')
      if (mark === ' ') {
        oldSide.push(text)
        newSide.push(text)
      } else if (mark === '-') oldSide.push(text)
      else if (mark === '+') newSide.push(text)
      else return null
      prev = mark
    }
    if (oldSide.length !== hunk.oldLines || newSide.length !== hunk.newLines) return null
    const at = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1
    if (at < 0 || at + newSide.length > lines.length) return null
    for (let i = 0; i < newSide.length; i++) {
      if (lines[at + i] !== newSide[i]) return null
    }
    touchesEnd ??= at + newSide.length === lines.length
    lines = lines.slice(0, at).concat(oldSide, lines.slice(at + newSide.length))
  }

  // A change that reaches the end says how the old text ended; otherwise it ended as the new one does.
  const hasFinalEol = touchesEnd === true ? !sawOldEnd : split.hasFinalEol
  if (lines.length === 0) return ''
  return lines.join(eol) + (hasFinalEol ? eol : '')
}
