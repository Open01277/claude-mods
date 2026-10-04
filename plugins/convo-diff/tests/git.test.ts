import { expect, test } from 'claude-code/testing'

import { gitArgv, isLeftover, parseRaw, parseTree, sameText, withEol } from '../hooks/git'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const NONE = '0'.repeat(40)

test('diff-tree says which files changed, with the blob each held before', () => {
  const out = [
    `:100644 100644 ${OLD} ${NEW} M`,
    'src/app.ts',
    `:000000 100644 ${NONE} ${NEW} A`,
    'docs/新的 檔案.md',
    `:100755 000000 ${OLD} ${NONE} D`,
    'bin/run.sh',
    '',
  ].join('\0')
  expect(parseRaw(out)).toEqual([
    { rel: 'src/app.ts', before: OLD },
    { rel: 'docs/新的 檔案.md', before: null },
    { rel: 'bin/run.sh', before: OLD },
  ])
})

test('links and submodules have no text to compare: a file that becomes one keeps its blob before', () => {
  const out = [
    `:120000 120000 ${OLD} ${NEW} M`,
    'link',
    `:160000 160000 ${OLD} ${NEW} M`,
    'vendor/lib',
    `:100644 120000 ${OLD} ${NEW} T`,
    'was-a-file',
    `:120000 100644 ${OLD} ${NEW} T`,
    'was-a-link',
    '',
  ].join('\0')
  expect(parseRaw(out)).toEqual([
    { rel: 'was-a-file', before: OLD },
    { rel: 'was-a-link', before: null },
  ])
  expect(parseRaw('')).toEqual([])
})

test("a blob git stored with LF takes back the CRLF the file has now; other endings stay as they are", () => {
  expect(withEol('a\nb\n', 'a\r\nB\r\n')).toBe('a\r\nb\r\n')
  expect(withEol('a\nb\n', 'a\nB\n')).toBe('a\nb\n')
  // Already CRLF: git kept it as it was (core.autocrlf off).
  expect(withEol('a\r\nb\r\n', 'a\r\nB\r\n')).toBe('a\r\nb\r\n')
})

test("only this plugin's own indexes, untouched for a day, are leftovers", () => {
  const now = Date.parse('2026-10-04T10:00:00Z')
  const twoDays = now - 2 * 24 * 3600_000
  expect(isLeftover('convo-diff-k3x9a1.index', twoDays, now)).toBe(true)
  expect(isLeftover('convo-diff-k3x9a1.index.lock', twoDays, now)).toBe(true)
  expect(isLeftover('convo-diff-k3x9a1.index', now - 3600_000, now)).toBe(false)
  expect(isLeftover('index', twoDays, now)).toBe(false)
  expect(isLeftover('index.lock', twoDays, now)).toBe(false)
})

test('git runs with its CRLF warnings off', () => {
  expect(gitArgv(['add', '-A'])).toEqual(['git', '-c', 'core.safecrlf=false', 'add', '-A'])
})

test('ls-tree says the blob each path has in a commit, links and submodules left out', () => {
  const out = [`100644 blob ${OLD}\tsrc/App.ts`, `100755 blob ${NEW}\tbin/run.sh`, `120000 blob ${NEW}\tlink`, `160000 commit ${OLD}\tvendor`, ''].join('\0')
  const tree = parseTree(out, path => path.toLowerCase())
  expect([...tree]).toEqual([
    ['src/app.ts', OLD],
    ['bin/run.sh', NEW],
  ])
})

test('texts alike but for CRLF are the same; a missing file is only the same as another missing one', () => {
  expect(sameText('a\r\nb\r\n', 'a\nb\n')).toBe(true)
  expect(sameText('a\n', 'b\n')).toBe(false)
  expect(sameText(null, null)).toBe(true)
  expect(sameText(null, '')).toBe(false)
})
