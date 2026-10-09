import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const NOW = Date.parse('2026-10-04T10:00:00Z')
const ROOT = 'D:\\proj'
const A = 'D:\\proj\\a.txt'
const B = 'D:\\proj\\b.txt'
const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as never
const SURFACES = ['terminal', 'desktop'] as const

const PANE_PROPS = {
  title: '對話 diff',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

function spelled(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

// Every string a drawing shows: text children, Button labels, Code sources and Markdown text.
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  const element = node as RenderElement & { children?: unknown[]; props?: Record<string, unknown> }
  const own = [element.props?.label, element.props?.source, element.props?.text].filter(
    (value): value is string => typeof value === 'string',
  )
  return [...own, ...(element.children ?? []).map(textOf)].join(' ')
}

type World = {
  startedAt: number
  files: Map<string, string>
  messages: unknown[]
  bash: unknown
  // What the next PowerShell command does to the files.
  shell: (() => void) | undefined
  status: string | undefined
  opened: string[]
  closed: string[]
  toasts: string[]
  logs: string[]
}

const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// The engine beneath the plugin: files in memory, and the file tools acting on them.
function world(on: On, files: Readonly<Record<string, string>>, root = ROOT): World {
  const w: World = {
    startedAt: NOW,
    files: new Map(Object.entries(files).map(([path, text]) => [spelled(path), text])),
    messages: [],
    bash: undefined,
    shell: undefined,
    status: undefined,
    opened: [],
    closed: [],
    toasts: [],
    logs: [],
  }
  const get = (path: string) => w.files.get(spelled(path))
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', ($, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('turn.start', ($, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('session.usage',() => ({ value: { startedAt: w.startedAt, context: { window: 200_000 }, rateLimits: [] } }) as never)
  on('session.root', () => ({ value: root }) as never)
  on('session.cwd', () => ({ value: root }) as never)
  on('session.messages', () => ({ value: w.messages }) as never)
  on('fs.read', ($, e) => {
    const text = get((e as { path: string }).path)
    if (text === undefined) throw new Error('ENOENT: no such file or directory')
    return { value: text } as never
  })
  on('fs.exists', ($, e) => ({ value: get((e as { path: string }).path) !== undefined }) as never)
  on('fs.write', ($, e) => {
    const { path, text } = e as { path: string; text: string }
    w.files.set(spelled(path), text)
    return { value: undefined } as never
  })
  on('ui.toast', ($, e) => {
    w.toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__convo-diff__${(e as { name: string }).name}` } }) as never)
  on('ui.status', ($, e) => {
    w.status = (e as { text: string | undefined }).text
    return { value: undefined } as never
  })
  on('ui.log', ($, e) => {
    w.logs.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.open', ($, e) => {
    w.opened.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    w.closed.push((e as { id: string }).id)
    return { value: undefined } as never
  })
  on('tool.call', ($, e) => {
    const call = e as unknown as Record<string, string> & { tool: string }
    if (call.tool === 'Edit') {
      const before = get(call.file_path) ?? ''
      w.files.set(spelled(call.file_path), before.replace(call.old_string, call.new_string))
      const result = { filePath: call.file_path, oldString: call.old_string, newString: call.new_string, originalFile: before }
      return { result: { ...result, structuredPatch: [], userModified: false, replaceAll: false } } as never
    }
    if (call.tool === 'Write') {
      const before = get(call.file_path)
      w.files.set(spelled(call.file_path), call.content)
      const type = before === undefined ? 'create' : 'update'
      return {
        result: { type, filePath: call.file_path, content: call.content, structuredPatch: [], originalFile: before ?? null },
      } as never
    }
    if (call.tool === 'Bash') {
      const isReadOnly = call.command.startsWith('ls')
      const result = { stdout: '', stderr: '', interrupted: false, ...(w.bash === undefined ? {} : { bashEditDiff: w.bash }) }
      return (isReadOnly ? { result, isReadOnly } : { result }) as never
    }
    if (call.tool === 'PowerShell') {
      // Its record names no files, as the engine's does.
      w.shell?.()
      w.shell = undefined
      const result = { stdout: '', stderr: '', interrupted: false, isImage: false }
      return (call.command.startsWith('Get-') ? { result, isReadOnly: true } : { result }) as never
    }
    return { result: {} } as never
  })
  return w
}

type Git = {
  indexes: Set<string>
  calls: string[][]
  // Commits the files named (all of them by default) as they are now, on top of HEAD.
  commit: (paths?: readonly string[]) => string
  // Stages the files named as they are now in the repo's own index, as `git add` would.
  stage: (paths: readonly string[]) => void
}

// Git beneath the plugin, over the world's files: `add -A` and `write-tree` hash them into trees, `diff-tree` and
// `cat-file` read those back, `status` compares the files with HEAD and the repo's index. Blobs store LF, as
// core.autocrlf does on Windows.
function fakeGit(on: On, w: World, top = 'D:/proj'): Git {
  const ids = new Map<string, string>()
  const blobs = new Map<string, string>()
  const trees = new Map<string, Map<string, string>>()
  const commits = new Map<string, Map<string, string>>()
  let head: string | null = null
  let staged = new Map<string, string>()
  // The repo's own index where it differs from HEAD.
  const repoIndex = new Map<string, string>()
  const idOf = (key: string) => {
    const id = ids.get(key) ?? (ids.size + 1).toString(16).padStart(40, '0')
    ids.set(key, id)
    return id
  }
  const blobOf = (text: string) => {
    const blob = text.replace(/\r\n/g, '\n')
    const id = idOf(`blob:${blob}`)
    blobs.set(id, blob)
    return id
  }
  const said = (stdout: string, exitCode = 0) => ({ value: { ...RAN, stdout, exitCode } }) as never
  const prefix = `${top.toLowerCase()}/`
  const git: Git = {
    indexes: new Set(),
    calls: [],
    commit: paths => {
      const tree = new Map(head === null ? [] : (commits.get(head) ?? []))
      const named = paths === undefined ? [...w.files.keys()].filter(path => path.startsWith(prefix)) : paths.map(spelled)
      for (const path of named) {
        const text = w.files.get(path)
        const rel = path.slice(prefix.length)
        repoIndex.delete(rel)
        if (text === undefined) {
          tree.delete(rel)
          continue
        }
        tree.set(rel, blobOf(text))
      }
      if (paths === undefined) repoIndex.clear()
      head = idOf(`commit:${commits.size}`)
      commits.set(head, tree)
      return head
    },
    stage: paths => {
      for (const path of paths.map(spelled)) {
        const text = w.files.get(path)
        if (text !== undefined) repoIndex.set(path.slice(prefix.length), blobOf(text))
      }
    },
  }
  // `git status --porcelain=v1 -z`: each file whose index differs from HEAD (X) or whose work tree differs from the
  // index (Y); `??` for one git does not track.
  const status = () => {
    const tree = head === null ? new Map<string, string>() : (commits.get(head) ?? new Map<string, string>())
    const inTree = [...w.files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length))
    const out: string[] = []
    for (const rel of [...new Set([...tree.keys(), ...repoIndex.keys(), ...inTree])].sort()) {
      const inHead = tree.get(rel)
      const inIndex = repoIndex.get(rel) ?? inHead
      const text = w.files.get(prefix + rel)
      const now = text === undefined ? undefined : idOf(`blob:${text.replace(/\r\n/g, '\n')}`)
      if (inIndex === undefined) {
        if (now !== undefined) out.push(`?? ${rel}`)
        continue
      }
      const x = inHead === inIndex ? ' ' : inHead === undefined ? 'A' : 'M'
      const y = now === undefined ? 'D' : now === inIndex ? ' ' : 'M'
      if (x !== ' ' || y !== ' ') out.push(`${x}${y} ${rel}`)
    }
    return out.map(entry => `${entry}\0`).join('')
  }
  on('fs.list', () => ({ value: [] }) as never)
  on('process.run', ($, e) => {
    const { argv, init } = e as { argv: string[]; init?: { env?: Record<string, string> } }
    if (argv[0] !== 'git') return { value: RAN } as never
    const args = argv[1] === '-c' ? argv.slice(3) : argv.slice(1)
    git.calls.push(args)
    const index = init?.env?.GIT_INDEX_FILE
    if (index !== undefined) git.indexes.add(index)
    // Every snapshot goes through an index; nothing else is run on one.
    if ((args[0] === 'add' || args[0] === 'write-tree') !== (index !== undefined)) return said('', 128)
    const [verb, ...rest] = args
    if (verb === 'status') return said(status())
    if (verb === 'rev-parse' && rest.includes('HEAD')) return head === null ? said('', 1) : said(`${head}\n`)
    if (verb === 'ls-tree') {
      const [, , commit = '', , ...paths] = rest
      const tree = commits.get(commit)
      if (tree === undefined) return said('', 128)
      return said(paths.filter(rel => tree.has(rel)).map(rel => `100644 blob ${tree.get(rel)}\t${rel}\0`).join(''))
    }
    if (verb === 'rev-parse') return said(rest[0] === '--show-toplevel' ? `${top}\n` : `${top}/.git\n`)
    if (verb === 'add') {
      staged = new Map()
      for (const [path, text] of w.files) {
        if (!path.startsWith(prefix)) continue
        const blob = text.replace(/\r\n/g, '\n')
        const id = idOf(`blob:${blob}`)
        blobs.set(id, blob)
        staged.set(path.slice(prefix.length), id)
      }
      return said('')
    }
    if (verb === 'write-tree') {
      const id = idOf(`tree:${JSON.stringify([...staged].sort())}`)
      trees.set(id, staged)
      return said(`${id}\n`)
    }
    if (verb === 'diff-tree') {
      const [before, after] = rest.slice(-2).map(id => trees.get(id ?? '') ?? new Map<string, string>())
      const out: string[] = []
      for (const rel of [...new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])])].sort()) {
        const old = before?.get(rel)
        const now = after?.get(rel)
        if (old === now) continue
        const none = '0'.repeat(40)
        const status = old === undefined ? 'A' : now === undefined ? 'D' : 'M'
        out.push(`:${old === undefined ? '000000' : '100644'} ${now === undefined ? '000000' : '100644'} ${old ?? none} ${now ?? none} ${status}`, rel)
      }
      return said(out.length === 0 ? '' : `${out.join('\0')}\0`)
    }
    if (verb === 'cat-file') {
      const blob = blobs.get(rest[1] ?? '')
      return blob === undefined ? said('', 128) : said(blob)
    }
    return said('', 128)
  })
  return git
}

async function drawn($: Engine, surface: (typeof SURFACES)[number] = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'convo-diff', surface, component: 'Pane', props: PANE_PROPS as never, requestId: 'convo-diff' })
  const text = textOf(await ui.drawn())
  await ui.unmount()
  return text
}

async function edit($: Engine, path: string, from: string, to: string): Promise<void> {
  await $.tool.call({ tool: 'Edit', file_path: path, old_string: from, new_string: to } as never)
}

test("only this conversation's changes show, each against the file before its first change", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\ntwo\nthree\n', [B]: 'x\n' })
  await $.session.start(START)
  await clock.advance(1000)
  expect(await drawn($)).toContain('這個對話還沒有改任何檔案')

  // Another session, or the person, changes b.txt: not this conversation's.
  w.files.set(spelled(B), 'x changed elsewhere\n')
  await edit($, A, 'two', 'TWO')
  await edit($, A, 'three', 'three\nfour')
  await clock.advance(1000)

  for (const surface of SURFACES) {
    const text = await drawn($, surface)
    expect(text).toContain('a.txt')
    expect(text).not.toContain('b.txt')
    expect(text).toContain('-two')
    expect(text).toContain('+TWO')
    expect(text).toContain('+four')
    expect(text).toContain('這個對話改了 1 個檔案')
  }
  expect(w.status).toContain('改了 1 個檔案 +2 -1')
})

test('a file written back to how it was shows no difference, a new one shows whole', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  world(on, { [A]: 'keep\n' })
  await $.session.start(START)
  await clock.advance(1000)

  await $.tool.call({ tool: 'Write', file_path: A, content: 'changed\n' } as never)
  await $.tool.call({ tool: 'Write', file_path: A, content: 'keep\n' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'D:\\proj\\new.md', content: '# hi\nthere\n' } as never)
  await clock.advance(1000)

  const text = await drawn($)
  expect(text).toContain('無差異')
  expect(text).toContain('改了又改回來')
  expect(text).toContain('new.md')
  expect(text).toContain('新增')
  expect(text).toContain('+# hi')
  expect(text).toContain('這個對話改了 1 個檔案')
})

test('Bash edits the engine tracked are followed: created, deleted and changed files', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'a\nb\nc\n', 'D:\\proj\\gone.txt': 'g1\ng2\n' })
  await $.session.start(START)
  await clock.advance(1000)

  // A read-only command never counts.
  w.bash = { files: [{ filePath: A, hunks: [] }], moreFiles: 0 }
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)

  w.files.set(spelled(A), 'a\nB\nc\n')
  w.files.delete(spelled('D:\\proj\\gone.txt'))
  w.files.set(spelled('D:\\proj\\made.txt'), 'm\n')
  w.bash = {
    files: [
      { filePath: 'a.txt', hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }] },
      { filePath: 'D:\\proj\\gone.txt', deleted: true, hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-g1', '-g2'] }] },
      { filePath: 'D:\\proj\\made.txt', created: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+m'] }] },
    ],
    moreFiles: 0,
  }
  await $.tool.call({ tool: 'Bash', command: 'sed -i s/b/B/ a.txt && rm gone.txt && echo m > made.txt' } as never)
  await clock.advance(1000)

  const text = await drawn($)
  expect(text).toContain('這個對話改了 3 個檔案')
  expect(text).toContain('-b')
  expect(text).toContain('+B')
  expect(text).toContain('gone.txt')
  expect(text).toContain('刪除')
  expect(text).toContain('-g1')
  expect(text).toContain('made.txt')
  expect(text).toContain('+m')
})

test('a /clear starts over, and going back to the first conversation finds its files in the store', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\n' })
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')
  await clock.advance(1000)
  expect(await drawn($)).toContain('+uno')

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  w.startedAt = NOW + 60_000
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await clock.advance(1000)
  expect(await drawn($)).toContain('這個對話還沒有改任何檔案')
  expect(w.status).toBeUndefined()

  w.startedAt = NOW
  await $.turn.start({ text: 'back again', turnId: 't2' } as never)
  await $.command.run({ command: 'convo-diff', args: '' } as never)
  const text = await drawn($)
  expect(text).toContain('-one')
  expect(text).toContain('+uno')
})

test('a conversation from before the mod was on is read from its transcript', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'new text\n' })
  w.messages = [
    { role: 'user', text: 'change a', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'u1',
          tool: 'Edit',
          input: { file_path: A, old_string: 'old', new_string: 'new' },
          result: { filePath: A, oldString: 'old', newString: 'new', originalFile: 'old text\n', structuredPatch: [] },
        },
        { tool_use_id: 'u2', tool: 'Read', input: { file_path: B }, result: { type: 'text' } },
      ],
    },
  ]
  await $.session.start(START)
  await clock.advance(1000)

  const text = await drawn($)
  expect(text).toContain('-old text')
  expect(text).toContain('+new text')
})

test("Bash changes in the transcript are undone from what came after them", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const C = 'D:\\proj\\c.txt'
  const D = 'D:\\proj\\d.txt'
  const w = world(on, { [C]: 'a\nB\nc\n', [D]: 'z\n', 'D:\\proj\\made.txt': 'm\n' })
  const bash = (files: unknown[]) => ({ stdout: '', stderr: '', interrupted: false, bashEditDiff: { files, moreFiles: 0 } })
  w.messages = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 'b1',
          tool: 'Bash',
          input: { command: 'sed and friends' },
          result: bash([
            { filePath: 'made.txt', created: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+m'] }] },
            { filePath: C, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }] },
            { filePath: D, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }] },
          ]),
        },
        // d.txt changed again afterwards: that Edit's record holds what the command left.
        {
          tool_use_id: 'e1',
          tool: 'Edit',
          input: { file_path: D, old_string: 'y', new_string: 'z' },
          result: { filePath: D, oldString: 'y', newString: 'z', originalFile: 'y\n', structuredPatch: [] },
        },
      ],
    },
  ]
  await $.session.start(START)
  await clock.advance(1000)

  const text = await drawn($)
  expect(text).toContain('這個對話改了 3 個檔案')
  expect(text).toContain('made.txt')
  expect(text).toContain('+m')
  expect(text).toContain('-b')
  expect(text).toContain('+B')
  expect(text).toContain('-x')
  expect(text).toContain('+z')
  expect(text).not.toContain('無法比對')
})

test('files fold and unfold, and the choice holds on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  world(on, { [A]: 'one\n', [B]: 'b\n' })
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')
  await edit($, B, 'b', 'bee')
  await clock.advance(1000)

  const ui = await $.ui.mount({ plugin: 'convo-diff', surface: 'terminal', component: 'Pane', props: PANE_PROPS as never, requestId: 'convo-diff' })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(2)
  await ui.press({ key: 'f0' })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(1)
  await ui.press({ key: 'fold' })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(0)
  await ui.press({ key: 'fold' })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(2)
  await ui.press({ key: 'f1' })
  await ui.unmount()

  // The choices are the session's, so another surface draws them the same.
  const text = await drawn($, 'desktop')
  expect(text).toContain('+uno')
  expect(text).not.toContain('+bee')
})

test("a first click on the desktop's pane presses; once the pane holds the keys, Tab only walks it", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\n', [B]: 'b\n' })
  on('process.run', () => ({ value: { ...RAN, exitCode: 128, stderr: 'fatal: not a git repository' } }) as never)
  on('ui.focus', () => ({}) as never)
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')
  await edit($, B, 'b', 'bee')
  await clock.advance(1000)

  const ui = await mountPane($, 'desktop')
  const codes = async () => (await ui.findAll({ type: 'Code' })).length
  const focus = async (element: string, origin: object = { kind: 'person' }) => {
    await $.ui.focus({ component: 'Pane', requestId: 'convo-diff', plugin: 'convo-diff', element, origin } as never)
    await clock.settle()
  }
  const holdsKeys = (isFocused: boolean) => ui.redraw({ ...PANE_PROPS, isFocused } as never)
  expect(await codes()).toBe(2)
  // The prompt holds the keys: the click lands as the ring, and that presses.
  await focus('f0')
  expect(await codes()).toBe(1)
  // The click itself, right behind the ring: the same press, not a second fold.
  await ui.press({ key: 'f0' })
  expect(await codes()).toBe(1)

  // The pane holds the keys: Tab walks every button without pressing one.
  await holdsKeys(true)
  await clock.advance(1000)
  for (const element of ['scope', 'refresh', 'fold', 'close', 'x0', 'r0']) await focus(element)
  expect(await codes()).toBe(1)
  expect(w.closed).toHaveLength(0)
  expect(w.toasts.filter(text => text.includes('解釋'))).toHaveLength(0)
  expect(await ui.find({ key: 'rc0' })).toBeUndefined()
  expect(textOf(await ui.drawn())).not.toContain('整段對話改了')
  // There a click presses by itself, once, every time.
  await focus('f0')
  await ui.press({ key: 'f0' })
  expect(await codes()).toBe(2)
  await ui.press({ key: 'f0' })
  await ui.press({ key: 'f0' })
  expect(await codes()).toBe(2)

  // A ring another plugin moves is no click.
  await holdsKeys(false)
  await focus('fold', { kind: 'plugin', name: 'x' })
  expect(await codes()).toBe(2)

  // The desktop may draw the pane holding the keys just before the ring move of the click that gave them.
  await clock.advance(1000)
  await holdsKeys(true)
  await focus('f1')
  expect(await codes()).toBe(1)

  // Back from the prompt, one click on 確定還原 reverts, as on any other button.
  await clock.advance(1000)
  await ui.press({ key: 'r0' })
  await holdsKeys(false)
  await focus('rc0')
  expect(w.files.get(spelled(A))).toBe('one\n')
  await ui.unmount()
})

test('in the terminal, Tab walks a pane that has just taken the keys without pressing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  world(on, { [A]: 'one\n', [B]: 'b\n' })
  on('ui.focus', () => ({}) as never)
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')
  await edit($, B, 'b', 'bee')
  await clock.advance(1000)

  const ui = await mountPane($)
  // ctrl+x tab gives the pane the keys, and Tab at once walks it.
  await ui.redraw({ ...PANE_PROPS, isFocused: true } as never)
  for (const element of ['scope', 'fold', 'f0']) {
    await $.ui.focus({ component: 'Pane', requestId: 'convo-diff', plugin: 'convo-diff', element, origin: { kind: 'person' } } as never)
    await clock.settle()
  }
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(2)
  expect(textOf(await ui.drawn())).not.toContain('整段對話改了')
  await ui.unmount()
})

test('files outside the repo never count, and git finds the repo above where the session started', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const scratch = 'C:\\Temp\\scratch.txt'
  const w = world(on, { [A]: 'one\n', [scratch]: 's\n' }, 'D:\\proj\\sub')
  const top = { exitCode: 0, stdout: 'D:/proj\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  on('process.run', () => ({ value: top }) as never)
  await $.session.start(START)
  await clock.advance(1000)

  await edit($, A, 'one', 'uno')
  await edit($, scratch, 's', 'scratch')
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\me\\.claude\\memory\\note.md', content: 'remember\n' } as never)
  await clock.advance(1000)

  for (const surface of SURFACES) {
    const text = await drawn($, surface)
    expect(text).toContain('a.txt')
    expect(text).toContain('+uno')
    expect(text).not.toContain('scratch')
    expect(text).not.toContain('note.md')
    expect(text).toContain('這個對話改了 1 個檔案')
  }
  expect(w.status).toContain('改了 1 個檔案')
  const patch = String(((await $.tool.call({ tool: 'mcp__convo-diff__diff' } as never)) as { result?: unknown }).result)
  expect(patch).toContain('--- a/a.txt')
  expect(patch).not.toContain('scratch')
})

test('the command opens the pane and the model can read the same diff', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\ntwo\n', [B]: 'b\n' })
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'two', 'TWO')
  await edit($, B, 'b', 'bee')

  const said = await $.command.run({ command: 'convo-diff', args: '' } as never)
  expect(said.text).toContain('這個對話改了 2 個檔案（+2 -2）')
  expect(w.opened).toContain('convo-diff')

  const all = await $.tool.call({ tool: 'mcp__convo-diff__diff' } as never)
  const patch = String((all as { result?: unknown }).result)
  expect(patch).toContain('--- a/a.txt')
  expect(patch).toContain('+++ b/a.txt')
  expect(patch).toContain('-two')
  expect(patch).toContain('+TWO')
  expect(patch).toContain('--- a/b.txt')

  const one = await $.tool.call({ tool: 'mcp__convo-diff__diff', path: 'b.txt' } as never)
  const only = String((one as { result?: unknown }).result)
  expect(only).toContain('+bee')
  expect(only).not.toContain('a.txt')
  console.log(patch)
})

async function mountPane($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  return $.ui.mount({ plugin: 'convo-diff', surface, component: 'Pane', props: PANE_PROPS as never, requestId: 'convo-diff' })
}

test('Explain asks Claude in the conversation, as the person, about that one file', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const OLD = 'D:\\proj\\old.txt'
  const w = world(on, { [A]: 'one\ntwo\n', [OLD]: 'bye\n' })
  const sent: { text: string; origin: unknown }[] = []
  on('prompt.submit', ($, e) => {
    const { text, origin } = e as { text: string; origin: unknown }
    sent.push({ text, origin })
    return { text } as never
  })
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'two', 'TWO')
  await $.tool.call({ tool: 'Write', file_path: 'D:\\proj\\new.md', content: '# new\n' } as never)
  w.bash = {
    files: [{ filePath: OLD, deleted: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-bye'] }] }],
    moreFiles: 0,
  }
  w.files.delete(spelled(OLD))
  await $.tool.call({ tool: 'Bash', command: 'rm old.txt' } as never)
  await clock.advance(1000)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'x0', type: 'Button' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await mountPane($)
  await ui.press({ key: 'x0' })
  await clock.advance(10)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.text).toContain('請解釋這個對話對 `a.txt` 做的改動')
  expect(sent[0]?.text).toContain('mcp__convo-diff__diff')
  expect(sent[0]?.text).toContain('不要修改任何檔案')
  // The person pressed for it: it reads as their own question.
  expect(sent[0]?.origin).toMatchObject({ kind: 'plugin', asUser: true })
  expect(w.toasts).toContain('已請 Claude 解釋 a.txt')
  // The answer is the conversation's: the pane draws none.
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0)

  // A file the conversation created, or removed, is asked about as one.
  await ui.press({ key: 'x1' })
  await ui.press({ key: 'x2' })
  await clock.advance(10)
  expect(sent[1]?.text).toContain('新增的 `new.md`')
  expect(sent[2]?.text).toContain('為什麼刪除 `old.txt`')

  // While Claude works, the question waits for the turn to end, and says so.
  await $.turn.start({ text: 'keep going', turnId: 't1' } as never)
  await ui.press({ key: 'x0' })
  await clock.advance(10)
  expect(w.toasts.at(-1)).toBe('Claude 這回合結束後會解釋 a.txt')
  await ui.unmount()
  console.log(sent.map(one => one.text).join('\n'))
})

test('Revert puts a file back after a yes, tells the model, and can be undone unless the file changed since', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\ntwo\n' })
  const N = 'D:\\proj\\made by claude.txt'
  const commands: string[][] = []
  on('process.run', ($, e) => {
    const argv = (e as { argv: string[] }).argv
    commands.push([...argv])
    const removed = /-LiteralPath '((?:[^']|'')*)' -Force/.exec(argv[4] ?? '')
    if (argv[0] === 'powershell' && removed !== null) w.files.delete(spelled((removed[1] ?? '').replace(/''/g, "'")))
    return { value: argv[0] === 'git' ? { ...RAN, exitCode: 128 } : RAN } as never
  })
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'two', 'TWO')
  await $.tool.call({ tool: 'Write', file_path: N, content: 'new file\n' } as never)
  await clock.advance(1000)

  const ui = await mountPane($)
  // Asked first; a no leaves the file alone.
  await ui.press({ key: 'r0' })
  expect(textOf(await ui.drawn())).toContain('把 a.txt 還原成這個對話改之前的內容？')
  await ui.press({ key: 'rn0' })
  expect(textOf(await ui.drawn())).not.toContain('還原成這個對話改之前的內容？')
  expect(w.files.get(spelled(A))).toBe('one\nTWO\n')

  await ui.press({ key: 'r0' })
  await ui.press({ key: 'rc0' })
  expect(w.files.get(spelled(A))).toBe('one\ntwo\n')
  expect(w.toasts.some(text => text.includes('已把 a.txt 還原'))).toBe(true)
  // The plugin tells the model through $.session.append, which the test kit has no conversation for:
  // the attempt is what shows here, and its failure costs the revert nothing.
  expect(w.logs.some(text => text.startsWith('could not tell the model'))).toBe(true)
  await clock.advance(1000)
  const reverted = textOf(await ui.drawn())
  expect(reverted).toContain('無差異')
  expect(reverted).toContain('復原')

  // Undo: the file is as the conversation left it.
  await ui.press({ key: 'u0' })
  expect(w.files.get(spelled(A))).toBe('one\nTWO\n')
  await clock.advance(1000)
  expect(textOf(await ui.drawn())).toContain('+TWO')

  // A file this conversation created is removed, and comes back on undo.
  await ui.press({ key: 'r1' })
  expect(textOf(await ui.drawn())).toContain('刪除 made by claude.txt？')
  await ui.press({ key: 'rc1' })
  expect(w.files.has(spelled(N))).toBe(false)
  expect(commands.some(argv => argv[0] === 'powershell' && (argv[4] ?? '').includes("'D:\\proj\\made by claude.txt'"))).toBe(true)
  await clock.advance(1000)
  expect(textOf(await ui.drawn())).toContain('建立之後又刪掉了')
  await ui.press({ key: 'u1' })
  expect(w.files.get(spelled(N))).toBe('new file\n')

  // Reverted, then changed again: an undo would lose that change, so it is refused.
  await ui.press({ key: 'r0' })
  await ui.press({ key: 'rc0' })
  await edit($, A, 'one', 'ONE')
  await ui.press({ key: 'u0' })
  expect(w.files.get(spelled(A))).toBe('ONE\ntwo\n')
  expect(w.toasts.some(text => text.includes('又被改過了'))).toBe(true)
  await clock.advance(1000)
  expect(await ui.find({ key: 'u0' })).toBeUndefined()
  await ui.unmount()
  console.log(w.toasts.join('\n'))
})

test('PowerShell commands are followed through git snapshots of the work tree', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const C = 'D:\\proj\\c.txt'
  const D = 'D:\\proj\\d.txt'
  const E = 'D:\\proj\\e.txt'
  const w = world(on, { [A]: 'one\ntwo\n', [B]: 'b1\r\nb2\r\n', [D]: 'gone\n' })
  const git = fakeGit(on, w)
  await $.session.start(START)
  await clock.advance(1000)

  // Changed by an Edit first: its base is its text before that, whatever the snapshots see later.
  await edit($, A, 'two', 'TWO')
  // Another session changes b.txt before the command: that change is not this conversation's.
  w.files.set(spelled(B), 'b1 elsewhere\r\nb2\r\n')
  w.shell = () => {
    w.files.set(spelled(A), 'one\nTWO\nthree\n')
    w.files.set(spelled(B), 'b1 elsewhere\r\nB2\r\n')
    w.files.set(spelled(C), 'made\n')
    w.files.delete(spelled(D))
  }
  await $.tool.call({ tool: 'PowerShell', command: "Set-Content b.txt 'B2'; Remove-Item d.txt" } as never)
  await clock.advance(1000)

  for (const surface of SURFACES) {
    const text = await drawn($, surface)
    expect(text).toContain('這個對話改了 4 個檔案')
    expect(text).toContain('-two')
    expect(text).toContain('+three')
    expect(text).toContain('-b2')
    expect(text).toContain('+B2')
    expect(text).not.toContain('-b1')
    expect(text).toContain('c.txt')
    expect(text).toContain('+made')
    expect(text).toContain('d.txt')
    expect(text).toContain('-gone')
    expect(text).not.toContain('無法比對')
  }
  // The snapshots go to an index of the plugin's own, never the repo's.
  expect([...git.indexes]).toHaveLength(1)
  expect([...git.indexes][0]).toMatch(/^D:\/proj\/\.git\/convo-diff-[0-9a-z]+\.index$/)

  // A read-only command follows nothing, even when a file changes meanwhile (the person typing in an editor), and
  // takes no snapshot: the one after the last command serves the next.
  const before = git.calls.length
  w.shell = () => w.files.set(spelled(E), 'typed by the person\n')
  await $.tool.call({ tool: 'PowerShell', command: 'Get-ChildItem' } as never)
  await clock.advance(1000)
  expect(await drawn($)).not.toContain('e.txt')
  expect(git.calls.slice(before).filter(args => args[0] === 'add')).toHaveLength(0)
  // What the person typed shows in the snapshot the next turn starts with, so no command takes it for its own.
  await $.turn.start({ text: 'go on', turnId: 't1' } as never)
  w.shell = () => w.files.set(spelled(A), 'one\nTWO\nthree\nfour\n')
  await $.tool.call({ tool: 'PowerShell', command: "Add-Content a.txt 'four'" } as never)
  await clock.advance(1000)
  expect(await drawn($)).not.toContain('e.txt')
  // One snapshot a command: none before it.
  expect(git.calls.slice(before).filter(args => args[0] === 'add')).toHaveLength(2)

  // A revert puts back the text the snapshot saw, with the CRLF the file has: git stored it with LF.
  const ui = await mountPane($)
  await ui.press({ key: 'r1' })
  await ui.press({ key: 'rc1' })
  expect(w.files.get(spelled(B))).toBe('b1 elsewhere\r\nb2\r\n')
  await ui.unmount()
})

test('with no git repo, PowerShell commands still run and follow nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\n' })
  on('process.run', () => ({ value: { ...RAN, exitCode: 128, stderr: 'fatal: not a git repository' } }) as never)
  await $.session.start(START)
  await clock.advance(1000)

  w.shell = () => w.files.set(spelled(A), 'uno\n')
  const ran = await $.tool.call({ tool: 'PowerShell', command: "Set-Content a.txt 'uno'" } as never)
  expect((ran as { deny?: string }).deny).toBeUndefined()
  await clock.advance(1000)
  expect(await drawn($)).toContain('這個對話還沒有改任何檔案')
  expect(w.files.get(spelled(A))).toBe('uno\n')
})

test("files a Bash command's record names without their changes are compared with the turn's snapshot", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const C = 'D:\\proj\\c.txt'
  const D = 'D:\\proj\\d.txt'
  const w = world(on, { [A]: 'one\n', [B]: 'b\n', [C]: 'c\n', [D]: 'd\n' })
  const git = fakeGit(on, w)
  await $.session.start(START)
  await clock.advance(1000)
  await $.turn.start({ text: 'add the guard to every script', turnId: 't1' } as never)
  // The snapshot is not awaited by the turn's start: the model thinks meanwhile.
  await clock.advance(10)
  const adds = () => git.calls.filter(args => args[0] === 'add').length
  expect(adds()).toBe(1)

  // One script changes three files; the engine keeps the changes of the first alone, as it does past five.
  w.files.set(spelled(A), 'uno\n')
  w.files.set(spelled(B), 'guard\nb\n')
  w.files.set(spelled(C), 'guard\nc\n')
  w.bash = {
    files: [{ filePath: A, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-one', '+uno'] }] }],
    moreFiles: 2,
    changedFiles: [A, B, C],
  }
  await $.tool.call({ tool: 'Bash', command: 'php add_guard.php' } as never)
  await clock.advance(1000)
  expect(adds()).toBe(2)

  // A command whose record holds no files at all is told by the snapshots too.
  w.files.set(spelled(D), 'guard\nd\n')
  w.bash = { files: [], moreFiles: 0, unavailable: true }
  await $.tool.call({ tool: 'Bash', command: 'php add_guard.php d.txt' } as never)
  await clock.advance(1000)
  expect(adds()).toBe(3)

  // A record with every change in it takes no snapshot.
  w.files.set(spelled(A), 'eins\n')
  w.bash = { files: [{ filePath: A, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-uno', '+eins'] }] }], moreFiles: 0 }
  await $.tool.call({ tool: 'Bash', command: "sed -i 's/uno/eins/' a.txt" } as never)
  await clock.advance(1000)
  expect(adds()).toBe(3)

  for (const surface of SURFACES) {
    const text = await drawn($, surface)
    expect(text).toContain('這個對話改了 4 個檔案')
    expect(text).toContain('-one')
    expect(text).toContain('+eins')
    for (const name of ['b.txt', 'c.txt', 'd.txt']) expect(text).toContain(name)
    expect(text).toContain('+guard')
    expect(text).not.toContain('無法比對')
  }
})

test('with no git repo, files a Bash record names without their changes cannot be compared', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\n', [B]: 'b\n' })
  on('process.run', () => ({ value: { ...RAN, exitCode: 128, stderr: 'fatal: not a git repository' } }) as never)
  await $.session.start(START)
  await clock.advance(1000)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)

  w.files.set(spelled(A), 'uno\n')
  w.files.set(spelled(B), 'bee\n')
  w.bash = {
    files: [{ filePath: A, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-one', '+uno'] }] }],
    moreFiles: 1,
    changedFiles: [A, B],
  }
  await $.tool.call({ tool: 'Bash', command: 'php both.php' } as never)
  await clock.advance(1000)

  const text = await drawn($)
  expect(text).toContain('+uno')
  expect(text).toContain('b.txt')
  expect(text).toContain('無法比對')
})

test("a long diff names its file again further down, so a scrolled pane still says whose it is", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const lines = (word: string) => Array.from({ length: 60 }, (_, at) => `${word} ${at}`).join('\n') + '\n'
  world(on, { [A]: lines('old'), [B]: 'b\n' })
  await $.session.start(START)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Write', file_path: A, content: lines('new') } as never)
  await edit($, B, 'b', 'bee')
  await clock.advance(1000)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const codes = await ui.findAll({ type: 'Code' })
    const text = textOf(await ui.drawn())
    await ui.unmount()
    // 121 rows of a.txt, in pieces of 34 (the pane's 40 rows less a margin): three more names; b.txt's is short.
    expect(text.split('a.txt（續）')).toHaveLength(4)
    expect(text).not.toContain('b.txt（續）')
    expect(codes).toHaveLength(5)
    expect(text).toContain('-old 59')
    expect(text).toContain('+new 59')
  }
})

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as const

async function mountBand($: Engine, surface: (typeof SURFACES)[number]) {
  return $.ui.mount({ plugin: 'convo-diff', surface, component: 'AbovePrompt', props: BAND_PROPS as never })
}

test('on the desktop a button above the prompt opens the pane, beside what other plugins draw there', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\n', [B]: 'b\n' })
  on('session.surfaces', () => ({ value: ['desktop'] }) as never)
  // Another plugin's band beneath this one, as quota-pets draws.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>(=^･ω･^=) 橘貓</Text>
  })
  await $.session.start(START)
  await clock.advance(1000)

  // Nothing changed yet: no button, the other band as it was.
  let ui = await mountBand($, 'desktop')
  expect(await ui.find({ key: 'open' })).toBeUndefined()
  expect(textOf(await ui.drawn())).toContain('橘貓')
  await ui.unmount()

  await edit($, A, 'one', 'uno')
  await edit($, B, 'b', 'bee')
  await clock.advance(1000)
  ui = await mountBand($, 'desktop')
  const text = textOf(await ui.drawn())
  expect(text).toContain('橘貓')
  expect(text).toContain('對話 diff（2）')
  expect(text.indexOf('橘貓')).toBeLessThan(text.indexOf('對話 diff'))
  // The button says it: no status line repeating the numbers under the prompt.
  expect(w.status).toBeUndefined()
  expect(w.opened).toHaveLength(0)
  await ui.press({ key: 'open' })
  expect(w.opened).toEqual(['convo-diff'])
  await ui.unmount()

  // The terminal keeps /convo-diff and the status line: the band stays the other plugin's.
  ui = await mountBand($, 'terminal')
  expect(await ui.find({ key: 'open' })).toBeUndefined()
  expect(textOf(await ui.drawn())).toContain('橘貓')
  await ui.unmount()
})

async function patchOf($: Engine, input: Record<string, string> = {}): Promise<string> {
  return String(((await $.tool.call({ tool: 'mcp__convo-diff__diff', ...input } as never)) as { result?: unknown }).result)
}

test('after a commit only what is not committed shows; the whole conversation is a click away, to read only', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\ntwo\n', [B]: 'b\n' })
  const git = fakeGit(on, w)
  // The engine draws nothing of its own in the band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  git.commit()
  await $.session.start(START)
  await clock.advance(1000)

  await edit($, A, 'two', 'TWO')
  await edit($, B, 'b', 'bee')
  // Claude commits: the command moves HEAD, and the diff follows it.
  git.commit()
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "two and bee"' } as never)
  await edit($, A, 'one', 'ONE')
  await clock.advance(1000)

  let text = await drawn($)
  expect(text).toContain('這個對話改了 1 個檔案')
  expect(text).toContain('-one')
  expect(text).toContain('+ONE')
  expect(text).not.toContain('-two')
  expect(text).toContain('跟上次 commit 比')
  expect(text).toContain('已經 commit、之後沒再改（1）：b.txt')
  expect(w.status).toContain('改了 1 個檔案 +1 -1')

  let patch = await patchOf($)
  expect(patch).toContain('+ONE')
  expect(patch).not.toContain('+TWO')
  expect(patch).toContain('# committed, unchanged since: b.txt')
  patch = await patchOf($, { scope: 'all' })
  expect(patch).toContain('+TWO')
  expect(patch).toContain('+ONE')
  expect(patch).toContain('+bee')

  // The whole conversation reads, but cannot revert: what is committed (and maybe pushed) stays.
  const ui = await mountPane($)
  await ui.press({ key: 'scope' })
  text = textOf(await ui.drawn())
  expect(text).toContain('整段對話改了 2 個檔案')
  expect(text).toContain('+TWO')
  expect(text).toContain('+bee')
  expect(text).toContain('只能看')
  expect(await ui.find({ key: 'r0' })).toBeUndefined()

  // Back to what is not committed: a revert goes back to the commit, not before it.
  await ui.press({ key: 'scope' })
  await ui.press({ key: 'r0' })
  expect(textOf(await ui.drawn())).toContain('把 a.txt 還原成上次 commit 的內容？')
  await ui.press({ key: 'rc0' })
  expect(w.files.get(spelled(A))).toBe('one\nTWO\n')
  expect(w.toasts.some(toast => toast.includes('已把 a.txt 還原成上次 commit 的樣子'))).toBe(true)
  await ui.unmount()

  // Everything committed: the desktop button stays, to reach the whole conversation, and says so.
  await edit($, A, 'one', 'ONE')
  git.commit()
  await $.tool.call({ tool: 'Bash', command: 'git commit -am one' } as never)
  await clock.advance(1000)
  const band = await mountBand($, 'desktop')
  expect(textOf(await band.drawn())).toContain('對話 diff（都 commit 了）')
  await band.unmount()
  expect(await drawn($)).toContain('這個對話的改動都 commit 了')
  expect(w.status).toBeUndefined()
})

test("changes from before the conversation stay out, and a commit that did not take a file leaves it alone", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const C = 'D:\\proj\\c.txt'
  const w = world(on, { [A]: 'one\ntwo\n', [C]: 'c\n' })
  const git = fakeGit(on, w)
  git.commit()
  // Not committed when the conversation starts: the person's own work.
  w.files.set(spelled(A), 'one\ntwo\nmine\n')
  await $.session.start(START)
  await clock.advance(1000)

  await edit($, A, 'two', 'TWO')
  await edit($, C, 'c', 'see')
  // A commit of c.txt alone (git add c.txt): a.txt is compared with its base as before.
  git.commit([C])
  await $.tool.call({ tool: 'Bash', command: 'git commit c.txt -m c' } as never)
  await clock.advance(1000)

  const text = await drawn($)
  expect(text).toContain('這個對話改了 1 個檔案')
  expect(text).toContain('+TWO')
  expect(text).not.toContain('+mine')
  expect(text).toContain('已經 commit、之後沒再改（1）：c.txt')
})

test('a file kept by an older version, its HEAD unknown, counts as committed when HEAD holds other text', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const kept = { key: 'd:/proj/a.txt', path: A, base: 'one\n', isLost: false, seq: 1 }
  mock.store(on, { [`conv:${NOW}`]: { v: 1, at: NOW, track: { conv: NOW, seq: 1, files: [kept] } } })
  const w = world(on, { [A]: 'uno\n' })
  const git = fakeGit(on, w)
  git.commit()
  w.files.set(spelled(A), 'uno\ndos\n')
  await $.session.start(START)
  await clock.advance(1000)

  const text = await drawn($)
  expect(text).toContain('+dos')
  expect(text).not.toContain('-one')
  expect(await patchOf($, { scope: 'all' })).toContain('-one')
})

const OTHER = NOW - 3_600_000

// Another conversation's line in the store: the files it changed, and what each held before.
function otherConversation(files: Readonly<Record<string, string | null>>, title: string | null = '修 Tab', session = 'local_other') {
  const tracked = Object.entries(files).map(([path, base], index) => ({ key: spelled(path), path, base, isLost: false, seq: index + 1, head: null }))
  return { [`conv:${OTHER}`]: { v: 1, at: OTHER, title, session, track: { conv: OTHER, seq: tracked.length, files: tracked } } }
}

async function run($: Engine, command: string, tool: 'Bash' | 'PowerShell' = 'Bash') {
  return (await $.tool.call({ tool, command } as never)) as { deny?: string; context?: readonly string[] }
}

test("git add -A is refused while another conversation has changes not committed; this conversation's own files go through", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, otherConversation({ [B]: 'b\n' }))
  const w = world(on, { [A]: 'one\n', [B]: 'b\n' })
  const git = fakeGit(on, w)
  git.commit()
  // The other conversation changed b.txt and has not committed it.
  w.files.set(spelled(B), 'b, as the other conversation left it\n')
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')

  const refused = await run($, 'git add -A && git commit -m "uno" && git push')
  expect(refused.deny).toContain('`git add -A` 會把別的對話還沒 commit 的改動一起 commit 進去')
  expect(refused.deny).toContain('- 另一個對話「修 Tab」：b.txt')
  expect(refused.deny).toContain('這一整行指令都沒有執行')
  expect(refused.deny).toContain('這個對話自己改、還沒 commit 的檔案：a.txt')
  expect(refused.deny).toContain('# convo-diff:allow')
  expect(w.toasts.at(-1)).toBe('convo-diff 擋下了 git add -A：會把另一個對話「修 Tab」還沒 commit 的 b.txt 一起 commit')

  // Only this conversation's file: it runs.
  expect((await run($, 'git add -- a.txt && git commit -m "uno" -- a.txt')).deny).toBeUndefined()
  // The person's own say-so lets it through, and the person hears of it.
  const allowed = await run($, 'git add -A && git commit -m "all of it" # convo-diff:allow')
  expect(allowed.deny).toBeUndefined()
  expect(allowed.context?.join('\n')).toContain('已照使用者的要求放行')
  expect(w.toasts.at(-1)).toBe('Claude 說是你要求的，convo-diff 放行了 git add -A：另一個對話「修 Tab」還沒 commit 的 b.txt 會一起 commit')
})

test("commands that would throw away another conversation's changes are refused, in Bash and in PowerShell", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const C = 'D:\\proj\\c.txt'
  mock.store(on, otherConversation({ [B]: 'b\n', [C]: null }))
  const w = world(on, { [A]: 'one\n', [B]: 'b\n' })
  const git = fakeGit(on, w)
  git.commit()
  w.files.set(spelled(B), 'b changed\n')
  w.files.set(spelled(C), 'made by the other conversation\n')
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')

  for (const command of ['git checkout -- .', 'git restore .', 'git reset --hard', 'git stash', 'git checkout -f main']) {
    for (const tool of ['Bash', 'PowerShell'] as const) {
      const { deny } = await run($, command, tool)
      expect(deny).toContain(`\`${command}\` 會把別的對話還沒 commit 的改動丟掉`)
      expect(deny).toContain('- 另一個對話「修 Tab」：b.txt')
      // A file git does not track is out of their reach.
      expect(deny).not.toContain('c.txt')
    }
  }
  // git clean takes what git does not track: the file the other conversation created.
  expect((await run($, 'git clean -fd')).deny).toContain('- 另一個對話「修 Tab」：c.txt')
  expect(w.toasts.at(-1)).toBe('convo-diff 擋下了 git clean -fd：會把另一個對話「修 Tab」還沒 commit 的 c.txt 丟掉')
  // This conversation's own file, by name, goes through.
  expect((await run($, 'git checkout -- a.txt')).deny).toBeUndefined()
  expect((await run($, 'git restore a.txt; git stash push -- a.txt', 'PowerShell')).deny).toBeUndefined()
})

test("another conversation's committed changes stand in no one's way, and commands that take no changes ask git nothing", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, otherConversation({ [B]: 'b\n' }))
  const w = world(on, { [A]: 'one\n', [B]: 'b\n' })
  const git = fakeGit(on, w)
  git.commit()
  // The other conversation committed its change to b.txt.
  w.files.set(spelled(B), 'b changed\n')
  git.commit([B])
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')

  expect((await run($, 'git add -A && git commit -m uno')).deny).toBeUndefined()
  const asked = () => git.calls.filter(args => args[0] === 'status').length
  const before = asked()
  await run($, 'git status && git log --oneline -3 && npm test')
  await run($, 'Get-ChildItem; git diff', 'PowerShell')
  expect(asked()).toBe(before)
})

test('with no other conversation, git status is never asked', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const w = world(on, { [A]: 'one\n' })
  const git = fakeGit(on, w)
  git.commit()
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')

  expect((await run($, 'git add -A && git commit -m uno && git reset --hard')).deny).toBeUndefined()
  expect(git.calls.filter(args => args[0] === 'status')).toHaveLength(0)
})

test('a file both conversations changed: its first change warns, committing it says so, throwing it away is refused', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, otherConversation({ [A]: 'one\n', [B]: 'b\n' }))
  const w = world(on, { [A]: 'one\n', [B]: 'b\n' })
  const git = fakeGit(on, w)
  git.commit()
  w.files.set(spelled(B), 'b\nfrom the other conversation\n')
  await $.session.start(START)
  await clock.advance(1000)

  // This conversation starts changing b.txt: the model and the person hear the other's changes are in it.
  const edited = (await $.tool.call({ tool: 'Edit', file_path: B, old_string: 'b\n', new_string: 'bee\n' } as never)) as {
    context?: readonly string[]
  }
  expect(edited.context?.join('\n')).toContain('- 另一個對話「修 Tab」：b.txt')
  expect(w.toasts.at(-1)).toBe('這個對話改到了 b.txt，裡面也有另一個對話「修 Tab」還沒 commit 的改動')
  // Only the first change warns.
  const again = (await $.tool.call({ tool: 'Edit', file_path: B, old_string: 'bee', new_string: 'BEE' } as never)) as {
    context?: readonly string[]
  }
  expect(again.context).toBeUndefined()

  // Committing it goes through, saying the other's changes go along.
  const committed = await run($, 'git add b.txt && git commit -m b')
  expect(committed.deny).toBeUndefined()
  expect(committed.context?.join('\n')).toContain('這次會一起 commit 進去')
  expect(w.toasts.at(-1)).toBe('b.txt 也有另一個對話「修 Tab」還沒 commit 的改動，這次會一起 commit')
  // Throwing it away would take the other's changes with it.
  expect((await run($, 'git checkout -- b.txt')).deny).toContain('兩個對話都改過的檔案')

  // a.txt is in the other conversation's list too, but nothing of it waits: starting on it warns nothing.
  const plain = (await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'one', new_string: 'uno' } as never)) as {
    context?: readonly string[]
  }
  expect(plain.context).toBeUndefined()
})

test('a commit takes what another conversation staged: refused, and a commit naming its own files goes through', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, otherConversation({ [B]: 'b\n' }))
  const w = world(on, { [A]: 'one\n', [B]: 'b\n' })
  const git = fakeGit(on, w)
  git.commit()
  // The other conversation staged its change, about to commit it.
  w.files.set(spelled(B), 'b staged\n')
  git.stage([B])
  await $.session.start(START)
  await clock.advance(1000)
  await edit($, A, 'one', 'uno')

  const { deny } = await run($, 'git add a.txt && git commit -m uno')
  expect(deny).toContain('`git commit -m` 會把別的對話還沒 commit 的改動一起 commit 進去')
  expect(deny).not.toContain('`git add a.txt`')
  expect((await run($, 'git add a.txt && git commit -m uno -- a.txt')).deny).toBeUndefined()
})

// The store in a map the test reads back.
function storeOf(on: On, entries: Readonly<Record<string, unknown>>): Map<string, unknown> {
  const kept = new Map(Object.entries(entries))
  on('store.get', ($, e) => ({ value: kept.get((e as { key: string }).key) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    kept.set(key, JSON.parse(JSON.stringify(value)))
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    kept.delete((e as { key: string }).key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...kept.keys()] }) as never)
  return kept
}

test('other conversations are named by title, by when they began, or as this one before a /clear', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const D = 'D:\\proj\\d.txt'
  const LATER = OTHER + 60_000
  const file = (path: string, base: string) => ({ key: spelled(path), path, base, isLost: false, seq: 1, head: null })
  const kept = storeOf(on, {
    ...otherConversation({ [B]: 'b\n' }, null, 'local_me'),
    [`conv:${LATER}`]: { v: 1, at: LATER, track: { conv: LATER, seq: 1, files: [file(D, 'd\n')] } },
  })
  const w = world(on, { [A]: 'one\n', [B]: 'b\n', [D]: 'd\n' })
  // The desktop says which session this is.
  on('mcp.call', ($, e) => {
    const { server, tool } = e as { server: string; tool: string }
    if (server !== 'ccd_session_mgmt' || tool !== 'get_session') throw new Error(`no tool ${tool}`)
    const text = JSON.stringify({ sessionId: 'local_me', title: '撞車保護' })
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  const git = fakeGit(on, w)
  git.commit()
  w.files.set(spelled(B), 'b changed\n')
  w.files.set(spelled(D), 'd changed\n')
  await $.session.start(START)
  await clock.advance(1000)

  const { deny } = await run($, 'git stash')
  const date = new Date(LATER)
  const two = (n: number) => String(n).padStart(2, '0')
  expect(deny).toContain('- 這個對話 /clear 之前的部分：b.txt')
  expect(deny).toContain(`- 另一個對話（${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())} 開始）：d.txt`)

  // This conversation's own line carries its session and title, for the others to name it by.
  await edit($, A, 'one', 'uno')
  expect(kept.get(`conv:${NOW}`)).toMatchObject({ session: 'local_me', title: '撞車保護' })
})
