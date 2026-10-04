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
  on('ui.close', () => ({ value: undefined }) as never)
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

type Git = { indexes: Set<string>; calls: string[][] }

// Git beneath the plugin, over the world's files: `add -A` and `write-tree` hash them into trees, `diff-tree` and
// `cat-file` read those back. Blobs store LF, as core.autocrlf does on Windows.
function fakeGit(on: On, w: World, top = 'D:/proj'): Git {
  const git: Git = { indexes: new Set(), calls: [] }
  const ids = new Map<string, string>()
  const blobs = new Map<string, string>()
  const trees = new Map<string, Map<string, string>>()
  let staged = new Map<string, string>()
  const idOf = (key: string) => {
    const id = ids.get(key) ?? (ids.size + 1).toString(16).padStart(40, '0')
    ids.set(key, id)
    return id
  }
  const said = (stdout: string, exitCode = 0) => ({ value: { ...RAN, stdout, exitCode } }) as never
  const prefix = `${top.toLowerCase()}/`
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

  // A read-only command follows nothing, even when a file changes meanwhile (the person typing in an editor).
  const before = git.calls.length
  w.shell = () => w.files.set(spelled(E), 'typed by the person\n')
  await $.tool.call({ tool: 'PowerShell', command: 'Get-ChildItem' } as never)
  await clock.advance(1000)
  expect(await drawn($)).not.toContain('e.txt')
  expect(git.calls.slice(before).filter(args => args[0] === 'add')).toHaveLength(1)

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
