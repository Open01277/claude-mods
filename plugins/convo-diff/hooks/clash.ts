// Which git commands in a command line would take files' changes: stage them for a commit (or commit them), or throw
// them away. What reads a command line, git's words, `git status` and pathspecs lives here; what knows the
// conversations, which needs `$`, in register.

import { absolute, fromMsys, isWindowsPath, keyOf, normalize, relOf } from './paths'

export type Shell = 'bash' | 'powershell'

// At the end of a command, a comment in both shells: it runs even though it takes another conversation's changes.
export const ALLOW = '# convo-diff:allow'

export function isAllowed(command: string): boolean {
  return command.includes(ALLOW.slice(2))
}

// Which of a file's changes a command takes: what is in the work tree, what is staged, or a file git does not track
// yet; under its pathspecs (null: the whole repo).
export type Takes = { worktree: boolean; index: boolean; untracked: boolean; specs: readonly string[] | null }

export type GitOp = {
  // stage: into a commit, this one or the next; discard: thrown away (or, by a stash, put aside).
  kind: 'stage' | 'discard'
  // As it reads in a message: `git add -A`.
  text: string
  // The folder git runs in, and whether its pathspecs are literal.
  cwd: string
  isLiteral: boolean
  takes: Takes[]
}

// A file `git status` lists: changed in the work tree, staged, or not tracked.
export type Dirty = { rel: string; worktree: boolean; index: boolean; untracked: boolean }

type Heredoc = { delimiter: string; isStripped: boolean }
type Quoted = { text: string; end: number }

function lineEnd(line: string, at: number): number {
  const end = line.indexOf('\n', at)
  return end < 0 ? line.length : end
}

// Bash's '…' takes everything literally; PowerShell's doubles a quote to write one.
function singleQuoted(line: string, at: number, isPs: boolean): Quoted {
  let text = ''
  let i = at + 1
  while (i < line.length) {
    if (line[i] === "'") {
      if (isPs && line[i + 1] === "'") {
        text += "'"
        i += 2
        continue
      }
      return { text, end: i + 1 }
    }
    text += line[i]
    i += 1
  }
  return { text, end: line.length }
}

// "…": bash escapes with \ only $ ` " \ and a newline, PowerShell anything with `; a substitution inside is kept whole.
function doubleQuoted(line: string, at: number, isPs: boolean): Quoted {
  let text = ''
  let i = at + 1
  while (i < line.length) {
    const c = line[i] ?? ''
    const d = line[i + 1] ?? ''
    if (c === '"') {
      if (isPs && d === '"') {
        text += '"'
        i += 2
        continue
      }
      return { text, end: i + 1 }
    }
    if (!isPs && c === '\\') {
      if (d === '\n') i += 2
      else if (d !== '' && '$`"\\'.includes(d)) {
        text += d
        i += 2
      } else {
        text += c
        i += 1
      }
      continue
    }
    if (isPs && c === '`') {
      text += d
      i += 2
      continue
    }
    if (c === '$' && d === '(') {
      const end = substitutionEnd(line, i + 1, isPs)
      text += line.slice(i, end)
      i = end
      continue
    }
    if (!isPs && c === '`') {
      const end = backtickEnd(line, i)
      text += line.slice(i, end)
      i = end
      continue
    }
    text += c
    i += 1
  }
  return { text, end: line.length }
}

// Bash's $'…', with its backslash escapes.
function ansiQuoted(line: string, at: number): Quoted {
  let text = ''
  let i = at + 1
  while (i < line.length) {
    const c = line[i] ?? ''
    if (c === "'") return { text, end: i + 1 }
    if (c === '\\') {
      const d = line[i + 1] ?? ''
      text += d === 'n' ? '\n' : d === 't' ? '\t' : d
      i += 2
      continue
    }
    text += c
    i += 1
  }
  return { text, end: line.length }
}

function backtickEnd(line: string, at: number): number {
  let i = at + 1
  while (i < line.length) {
    if (line[i] === '\\') i += 2
    else if (line[i] === '`') return i + 1
    else i += 1
  }
  return line.length
}

// A heredoc's delimiter, read right after its `<<`: quotes taken off, `<<-` strips the body's leading tabs.
function heredocAt(line: string, at: number): { doc: Heredoc; end: number } {
  let i = at
  const isStripped = line[i] === '-'
  if (isStripped) i += 1
  while (line[i] === ' ' || line[i] === '\t') i += 1
  let delimiter = ''
  while (i < line.length && !/[\s;&|()<>]/.test(line[i] ?? '')) {
    const c = line[i] ?? ''
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1)
      const end = close < 0 ? line.length : close
      delimiter += line.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (c === '\\') {
      delimiter += line[i + 1] ?? ''
      i += 2
      continue
    }
    delimiter += c
    i += 1
  }
  return { doc: { delimiter, isStripped }, end: i }
}

// Past the bodies of the heredocs a line opened, from the start of the line after it.
function skipHeredocs(line: string, at: number, docs: readonly Heredoc[]): number {
  let from = at
  for (const doc of docs) {
    while (from < line.length) {
      const end = lineEnd(line, from)
      let text = line.slice(from, end).replace(/\r$/, '')
      if (doc.isStripped) text = text.replace(/^\t+/, '')
      from = end + 1
      if (text === doc.delimiter) break
    }
  }
  return Math.min(from, line.length)
}

// The end of a $(…) (or PowerShell's @(…)) opened at `at`: quotes, nested parens and heredocs inside skipped.
function substitutionEnd(line: string, at: number, isPs: boolean): number {
  let depth = 0
  const docs: Heredoc[] = []
  let i = at
  while (i < line.length) {
    const c = line[i] ?? ''
    if (c === '\n' && docs.length > 0) {
      i = skipHeredocs(line, i + 1, docs.splice(0))
      continue
    }
    if (c === (isPs ? '`' : '\\')) {
      i += 2
      continue
    }
    if (c === "'") {
      i = singleQuoted(line, i, isPs).end
      continue
    }
    if (c === '"') {
      i = doubleQuoted(line, i, isPs).end
      continue
    }
    if (!isPs && c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const read = heredocAt(line, i + 2)
      docs.push(read.doc)
      i = read.end
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return line.length
}

// PowerShell's @'…'@ and @"…"@: the body is the lines between the opener, last on its line, and the closer that
// starts a line. Null where `@'` opens no here-string.
function hereString(line: string, at: number): Quoted | null {
  const quote = line[at + 1] ?? ''
  const open = lineEnd(line, at + 2)
  if (line.slice(at + 2, open).trim() !== '') return null
  const lines: string[] = []
  let from = open + 1
  while (from < line.length) {
    const end = lineEnd(line, from)
    const text = line.slice(from, end).replace(/\r$/, '')
    if (text.startsWith(`${quote}@`)) return { text: lines.join('\n'), end: from + 2 }
    lines.push(text)
    from = end + 1
  }
  return { text: lines.join('\n'), end: line.length }
}

// The simple commands a command line runs, each as its words with the quotes taken off. A heredoc's or a
// here-string's body, and what a command substitution runs, stay inside a word (a commit message), never a command of
// their own; a comment and a redirection's target are no words at all.
export function commandsOf(line: string, shell: Shell): string[][] {
  const isPs = shell === 'powershell'
  const escape = isPs ? '`' : '\\'
  const commands: string[][] = []
  const heredocs: Heredoc[] = []
  let words: string[] = []
  let word: string | null = null
  // The next word is a redirection's target.
  let isTarget = false

  const add = (text: string) => {
    word = (word ?? '') + text
  }
  const endWord = () => {
    if (word === null) return
    if (isTarget) isTarget = false
    else words.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }

  let at = 0
  while (at < line.length) {
    const c = line[at] ?? ''
    const d = line[at + 1] ?? ''
    if (c === '\r' && d === '\n') {
      at += 1
      continue
    }
    if (c === '\n') {
      endCommand()
      at = heredocs.length > 0 ? skipHeredocs(line, at + 1, heredocs.splice(0)) : at + 1
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      at += 1
      continue
    }
    if (c === '#' && word === null) {
      at = lineEnd(line, at)
      continue
    }
    if (isPs && c === '<' && d === '#') {
      const close = line.indexOf('#>', at + 2)
      at = close < 0 ? line.length : close + 2
      continue
    }
    if (c === escape) {
      if (d === '\n') at += 2
      else if (d === '\r' && line[at + 2] === '\n') at += 3
      else {
        add(d)
        at += 2
      }
      continue
    }
    if (c === "'") {
      const quoted = singleQuoted(line, at, isPs)
      add(quoted.text)
      at = quoted.end
      continue
    }
    if (c === '"') {
      const quoted = doubleQuoted(line, at, isPs)
      add(quoted.text)
      at = quoted.end
      continue
    }
    if (!isPs && c === '$' && d === "'") {
      const quoted = ansiQuoted(line, at + 1)
      add(quoted.text)
      at = quoted.end
      continue
    }
    if ((c === '$' || (isPs && c === '@')) && d === '(') {
      const end = substitutionEnd(line, at + 1, isPs)
      add(line.slice(at, end))
      at = end
      continue
    }
    if (isPs && c === '@' && (d === "'" || d === '"')) {
      const here = hereString(line, at)
      if (here !== null) {
        add(here.text)
        at = here.end
        continue
      }
    }
    if (!isPs && c === '`') {
      const end = backtickEnd(line, at)
      add(line.slice(at, end))
      at = end
      continue
    }
    if (c === ';' || c === '(' || c === ')') {
      endCommand()
      at += 1
      continue
    }
    if ((c === '{' || c === '}') && word === null) {
      endCommand()
      at += 1
      continue
    }
    if (c === '|') {
      endCommand()
      at += d === '|' ? 2 : 1
      continue
    }
    if (c === '&') {
      if (d === '&') {
        endCommand()
        at += 2
      } else if (!isPs && d === '>') {
        endWord()
        isTarget = true
        at += line[at + 2] === '>' ? 3 : 2
      } else if (isPs && word === null && words.length === 0) {
        // PowerShell's call operator: `& git …`.
        at += 1
      } else {
        endCommand()
        at += 1
      }
      continue
    }
    if (c === '>' || c === '<') {
      // A descriptor written right before it (2>, PowerShell's *>) is no word.
      if (word !== null && /^(\d+|\*)$/.test(word)) word = null
      else endWord()
      if (!isPs && c === '<' && d === '<') {
        if (line[at + 2] === '<') {
          // <<<: its word is the input, no argument.
          isTarget = true
          at += 3
          continue
        }
        const read = heredocAt(line, at + 2)
        heredocs.push(read.doc)
        at = read.end
        continue
      }
      let end = at + 1
      while (line[end] === '>' || line[end] === '|') end += 1
      if (line[end] === '&' && /[0-9-]/.test(line[end + 1] ?? '')) {
        // >&2, 2>&1, <&-: another descriptor, no file.
        end += 1
        while (/[0-9-]/.test(line[end] ?? '')) end += 1
        at = end
        continue
      }
      if (line[end] === '&') end += 1
      isTarget = true
      at = end
      continue
    }
    add(c)
    at += 1
  }
  endCommand()
  return commands
}

const BASH_PREFIXES = ['command', 'builtin', 'exec', 'nohup', 'time', 'env', 'sudo']

// The words the command itself starts with: bash's `NAME=value`, `env`, `command` and the like, and PowerShell's call
// operator, taken off.
function commandWords(words: readonly string[], isPs: boolean): string[] {
  let rest = [...words]
  for (;;) {
    const first = rest[0]
    if (first === undefined) return rest
    if (isPs ? first === '&' || first === '.' : /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      rest = rest.slice(1)
      continue
    }
    if (!isPs && BASH_PREFIXES.includes(first)) {
      rest = rest.slice(1)
      while (rest[0]?.startsWith('-') === true) rest = rest.slice(1)
      continue
    }
    return rest
  }
}

const BASH_CD = ['cd', 'pushd']
const BASH_BACK = ['popd']
const PS_CD = ['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location']
const PS_BACK = ['popd', 'pop-location']

// Where a `cd` goes: null where the line cannot tell (home, `-`, a variable).
function cdTarget(args: readonly string[], cwd: string, isPs: boolean): string | null {
  let target: string | undefined
  for (let at = 0; at < args.length; at++) {
    const word = args[at] ?? ''
    if (isPs && /^-(path|literalpath|lp|pspath)$/i.test(word)) {
      target = args[at + 1]
      break
    }
    if (isPs && /^-stackname$/i.test(word)) {
      at += 1
      continue
    }
    if (word.startsWith('-') && word !== '-') continue
    target = word
    break
  }
  if (target === undefined || target === '-' || target.startsWith('~') || target.includes('$')) return null
  return normalize(absolute(fromMsys(target, cwd), cwd))
}

function isGit(name: string): boolean {
  const base = (name.split(/[\\/]/).pop() ?? '').toLowerCase()
  return base === 'git' || base === 'git.exe'
}

type Options = {
  has: (...names: string[]) => boolean
  // The other words, pathspecs among them; those after `--` from `dashAt` on (-1: there is no `--`).
  args: string[]
  dashAt: number
  // The words as a message shows them: an option's value left out.
  shown: string[]
}

// A subcommand's options and its other words, as git's own parser reads them. A `valued` option takes the next word,
// or what follows it in its cluster (`-mfix`) or after `=`; an `attached` one only what follows it in its cluster
// (`-S<key>`).
function optionsOf(words: readonly string[], valued: readonly string[], attached: readonly string[] = []): Options {
  const flags = new Set<string>()
  const args: string[] = []
  const shown: string[] = []
  let dashAt = -1
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? ''
    if (dashAt >= 0) {
      args.push(word)
      shown.push(word)
    } else if (word === '--') {
      dashAt = args.length
      shown.push(word)
    } else if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = eq < 0 ? word : word.slice(0, eq)
      flags.add(name)
      shown.push(name)
      if (eq < 0 && valued.includes(name)) at += 1
    } else if (word.startsWith('-') && word.length > 1) {
      let end = word.length
      for (let i = 1; i < word.length; i++) {
        const name = `-${word[i]}`
        flags.add(name)
        if (attached.includes(name)) {
          end = i + 1
          break
        }
        if (valued.includes(name)) {
          if (i === word.length - 1) at += 1
          end = i + 1
          break
        }
      }
      shown.push(word.slice(0, end))
    } else {
      args.push(word)
      shown.push(word)
    }
  }
  return { has: (...names) => names.some(name => flags.has(name)), args, dashAt, shown }
}

function textOf(name: string, shown: readonly string[]): string {
  const text = ['git', name, ...shown].join(' ')
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

function looksLikePath(word: string): boolean {
  return word === '.' || word.startsWith('./') || word.startsWith('../') || word.startsWith(':') || /[*?[]/.test(word)
}

function take(worktree: boolean, index: boolean, untracked: boolean, specs: readonly string[] | null): Takes {
  return { worktree, index, untracked, specs }
}

const COMMIT_VALUED = [
  '-m',
  '--message',
  '-F',
  '--file',
  '-C',
  '--reuse-message',
  '-c',
  '--reedit-message',
  '-t',
  '--template',
  '--author',
  '--date',
  '--cleanup',
  '--fixup',
  '--squash',
  '--trailer',
  '--pathspec-from-file',
]

// What one git command (its words after `git`, run in `cwd`) does to files' changes; null for one that takes none.
export function gitOpOf(argv: readonly string[], cwd: string): GitOp | null {
  let here = normalize(cwd)
  let isLiteral = false
  let at = 0
  while (at < argv.length) {
    const word = argv[at] ?? ''
    if (word === '-C') {
      const dir = argv[at + 1]
      if (dir === undefined || dir.startsWith('~') || dir.includes('$')) return null
      here = normalize(absolute(fromMsys(dir, here), here))
      at += 2
      continue
    }
    // Another repo, or this one laid out otherwise: no telling which files it means.
    if (/^--(git-dir|work-tree)(=|$)/.test(word)) return null
    if (word === '-c' || word === '--namespace' || word === '--config-env' || word === '--super-prefix') {
      at += 2
      continue
    }
    if (word === '--literal-pathspecs') isLiteral = true
    if (!word.startsWith('-')) break
    at += 1
  }
  const sub = argv[at]
  const words = argv.slice(at + 1)
  const op = (kind: GitOp['kind'], name: string, parsed: Options, takes: Takes[]): GitOp => ({
    kind,
    text: textOf(name, parsed.shown),
    cwd: here,
    isLiteral,
    takes,
  })

  switch (sub) {
    case 'add':
    case 'stage': {
      const o = optionsOf(words, ['--chmod', '--pathspec-from-file'])
      if (o.has('-n', '--dry-run')) return null
      const isUpdate = o.has('-u', '--update')
      const isFromFile = o.has('--pathspec-from-file')
      if (o.args.length === 0 && !isUpdate && !isFromFile && !o.has('-A', '--all', '--no-ignore-removal')) return null
      return op('stage', sub, o, [take(true, false, !isUpdate, isFromFile || o.args.length === 0 ? null : o.args)])
    }
    case 'commit': {
      const o = optionsOf(words, COMMIT_VALUED, ['-S', '-u'])
      if (o.has('--dry-run')) return null
      if (o.has('--pathspec-from-file')) return op('stage', sub, o, [take(true, true, false, null)])
      // What is staged, and with -a every tracked file's changes.
      if (o.args.length === 0) return op('stage', sub, o, [take(o.has('-a', '--all'), true, false, null)])
      if (o.has('-i', '--include')) return op('stage', sub, o, [take(false, true, false, null), take(true, true, false, o.args)])
      return op('stage', sub, o, [take(true, true, false, o.args)])
    }
    case 'checkout': {
      const o = optionsOf(words, ['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'])
      const all = o.has('-f', '--force') ? [take(true, true, false, null)] : []
      if (o.has('--pathspec-from-file')) return op('discard', sub, o, [take(true, true, false, null)])
      const before = o.dashAt < 0 ? o.args : o.args.slice(0, o.dashAt)
      const paths = o.dashAt < 0 ? [] : o.args.slice(o.dashAt)
      // From a commit, what is staged goes too; from the index, only the work tree's changes.
      if (paths.length > 0) return op('discard', sub, o, [take(true, before.length > 0, false, paths), ...all])
      if (o.dashAt < 0 && before.length > 0 && !o.has('-b', '-B', '--orphan', '--detach')) {
        // No `--`: a branch or paths. Read as paths, a branch names no file another conversation changed.
        const isFromCommit = before.length > 1 && !looksLikePath(before[0] ?? '')
        return op('discard', sub, o, [take(true, isFromCommit, false, before), ...all])
      }
      return all.length > 0 ? op('discard', sub, o, all) : null
    }
    case 'switch': {
      const o = optionsOf(words, ['-c', '-C', '--create', '--force-create', '--orphan', '--conflict'])
      return o.has('-f', '--force', '--discard-changes') ? op('discard', sub, o, [take(true, true, false, null)]) : null
    }
    case 'restore': {
      const o = optionsOf(words, ['-s', '--source', '--conflict', '--pathspec-from-file'])
      const isStaged = o.has('-S', '--staged')
      // Only unstaging: the work tree keeps the changes.
      if (isStaged && !o.has('-W', '--worktree')) return null
      const specs = o.has('--pathspec-from-file') ? null : o.args
      if (specs !== null && specs.length === 0) return null
      return op('discard', sub, o, [take(true, isStaged, false, specs)])
    }
    case 'reset': {
      const o = optionsOf(words, ['--pathspec-from-file'])
      return o.has('--hard', '--merge') ? op('discard', sub, o, [take(true, true, false, null)]) : null
    }
    case 'stash': {
      const [first] = words
      if (first !== undefined && first !== 'push' && first !== 'save' && !first.startsWith('-')) return null
      const isNamed = first === 'push' || first === 'save'
      const o = optionsOf(isNamed ? words.slice(1) : words, ['-m', '--message', '--pathspec-from-file'])
      const specs = first === 'save' || o.has('--pathspec-from-file') || o.args.length === 0 ? null : o.args
      const name = isNamed ? `stash ${first}` : 'stash'
      if (o.has('-S', '--staged')) return op('discard', name, o, [take(false, true, false, specs)])
      return op('discard', name, o, [take(true, true, o.has('-u', '--include-untracked', '-a', '--all'), specs)])
    }
    case 'clean': {
      const o = optionsOf(words, ['-e', '--exclude'])
      if (o.has('-n', '--dry-run')) return null
      // Without pathspecs, the folder it runs in.
      return op('discard', sub, o, [take(false, false, true, o.args.length > 0 ? o.args : ['.'])])
    }
    case 'rm': {
      const o = optionsOf(words, ['--pathspec-from-file'])
      if (o.has('-n', '--dry-run')) return null
      const specs = o.has('--pathspec-from-file') ? null : o.args
      if (specs !== null && specs.length === 0) return null
      return op(o.has('--cached') ? 'stage' : 'discard', sub, o, [take(true, true, false, specs)])
    }
    default:
      return null
  }
}

// The git commands a command line runs that take files' changes, each with the folder it runs in. A `cd` the line
// makes moves the commands after it; one to a folder it cannot tell leaves them out.
export function gitOpsOf(command: string, shell: Shell, cwd: string): GitOp[] {
  const isPs = shell === 'powershell'
  const ops: GitOp[] = []
  let here: string | null = normalize(cwd)
  for (const words of commandsOf(command, shell)) {
    const [name = '', ...args] = commandWords(words, isPs)
    const spelled = isPs ? name.toLowerCase() : name
    if ((isPs ? PS_CD : BASH_CD).includes(spelled)) {
      here = here === null ? null : cdTarget(args, here, isPs)
      continue
    }
    if ((isPs ? PS_BACK : BASH_BACK).includes(spelled)) {
      here = null
      continue
    }
    if (here === null || !isGit(name)) continue
    const op = gitOpOf(args, here)
    if (op !== null) ops.push(op)
  }
  return ops
}

// `git status --porcelain=v1 -z`: `XY path`, NUL, and after a rename or copy the path it came from, NUL.
export function parseStatus(out: string): Dirty[] {
  const parts = out.split('\0')
  const dirty: Dirty[] = []
  for (let at = 0; at < parts.length; at++) {
    const entry = parts[at] ?? ''
    if (entry.length < 4 || entry[2] !== ' ') continue
    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '
    const rel = entry.slice(3)
    if (x === '!') continue
    if (x === '?') {
      dirty.push({ rel, worktree: false, index: false, untracked: true })
      continue
    }
    dirty.push({ rel, worktree: y !== ' ', index: x !== ' ', untracked: false })
    if ('RC'.includes(x) || 'RC'.includes(y)) {
      const from = parts[at + 1] ?? ''
      at += 1
      // What a staged rename moved away is a change of its own.
      if (x === 'R' && from !== '') dirty.push({ rel: from, worktree: false, index: true, untracked: false })
    }
  }
  return dirty
}

type Spec = { isExclude: boolean; pattern: string; isGlob: boolean }

// A pathspec as git reads it in `cwd`, its pattern from the repo's top: 'all' for one whose magic says nothing this
// can read, null for one naming nothing in the repo.
function specOf(raw: string, cwd: string, top: string, isLiteral: boolean): Spec | 'all' | null {
  let rest = raw
  let isTop = false
  let isExclude = false
  let isGlob = !isLiteral
  if (!isLiteral && raw.startsWith(':(')) {
    const close = raw.indexOf(')')
    if (close < 0) return 'all'
    for (const magic of raw.slice(2, close).split(',')) {
      const name = magic.trim()
      if (name === 'top') isTop = true
      else if (name === 'exclude') isExclude = true
      else if (name === 'literal') isGlob = false
      else if (name !== 'glob' && name !== 'icase' && name !== '') return isExclude ? null : 'all'
    }
    rest = raw.slice(close + 1)
  } else if (!isLiteral && raw.startsWith(':')) {
    let at = 1
    for (; at < raw.length; at++) {
      const c = raw[at]
      if (c === '/') isTop = true
      else if (c === '!' || c === '^') isExclude = true
      else break
    }
    if (raw[at] === ':') at += 1
    rest = raw.slice(at)
  }
  const base = isTop ? top : cwd
  const path = rest === '' ? normalize(base) : normalize(absolute(fromMsys(rest, top), base))
  const rel = keyOf(path) === keyOf(top) ? '' : relOf(path, top)
  if (rel === null) return null
  return { isExclude, pattern: rel, isGlob: isGlob && /[*?[]/.test(rest) }
}

// git's pathspec glob: `*` and `?` match `/` too.
function globOf(pattern: string): RegExp {
  let source = ''
  for (let at = 0; at < pattern.length; at++) {
    const c = pattern[at] ?? ''
    const close = c === '[' ? pattern.indexOf(']', at + 2) : -1
    if (c === '*') source += '.*'
    else if (c === '?') source += '.'
    else if (close > 0) {
      source += `[${pattern.slice(at + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
      at = close
    } else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}(/.*)?$`)
}

function specTakes(spec: Spec, rel: string, fold: (text: string) => string): boolean {
  const pattern = fold(spec.pattern)
  if (pattern === '') return true
  if (spec.isGlob) return globOf(pattern).test(rel)
  return rel === pattern || rel.startsWith(`${pattern}/`)
}

// Whether pathspecs written in `cwd` take the file `rel` (from the repo's top), exclusions applied. Only exclusions
// leave the whole repo to exclude from.
function specsTake(specs: readonly string[], rel: string, cwd: string, top: string, isLiteral: boolean): boolean {
  const fold = (text: string) => (isWindowsPath(top) ? text.toLowerCase() : text)
  const file = fold(rel)
  let isIncluded = false
  let hasInclude = false
  let hasExclude = false
  for (const raw of specs) {
    const spec = specOf(raw, cwd, top, isLiteral)
    if (spec === null) continue
    if (spec === 'all') {
      hasInclude = true
      isIncluded = true
    } else if (spec.isExclude) {
      hasExclude = true
      if (specTakes(spec, file, fold)) return false
    } else {
      hasInclude = true
      if (specTakes(spec, file, fold)) isIncluded = true
    }
  }
  return hasInclude ? isIncluded : hasExclude
}

// Whether a git command takes this file's changes: of a kind it takes, under one of its pathspecs.
export function takesFile(op: GitOp, file: Dirty, top: string): boolean {
  return op.takes.some(
    one =>
      ((one.worktree && file.worktree) || (one.index && file.index) || (one.untracked && file.untracked)) &&
      (one.specs === null || specsTake(one.specs, file.rel, op.cwd, top, op.isLiteral)),
  )
}
