import { expect, test } from 'claude-code/testing'

import { diffText, printable, unapply } from '../hooks/diff'
import type { Hunk } from '../hooks/diff'

function numbered(count: number, change?: (n: number) => string | null): string {
  const lines: string[] = []
  for (let n = 1; n <= count; n++) {
    lines.push(change?.(n) ?? `line ${n}`)
  }
  return `${lines.join('\n')}\n`
}

// What <Code format="diff"> asks of a source: every header's counts match the lines under it.
function expectValidHunks(source: string): void {
  const lines = source.split('\n')
  let index = 0
  while (index < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[index] ?? '')
    expect(header).not.toBeNull()
    const oldCount = Number(header?.[2])
    const newCount = Number(header?.[4])
    let olds = 0
    let news = 0
    index++
    while (index < lines.length && !(lines[index] ?? '').startsWith('@@')) {
      const mark = (lines[index] ?? '').charAt(0)
      expect([' ', '-', '+']).toContain(mark)
      if (mark !== '+') olds++
      if (mark !== '-') news++
      index++
    }
    expect(olds).toBe(oldCount)
    expect(news).toBe(newCount)
  }
}

test('one changed line comes with three lines of context on each side', () => {
  const diff = diffText(numbered(20), numbered(20, n => (n === 10 ? 'changed 10' : null)))
  expect(diff.added).toBe(1)
  expect(diff.removed).toBe(1)
  expect(diff.chunks).toEqual([
    '@@ -7,7 +7,7 @@\n line 7\n line 8\n line 9\n-line 10\n+changed 10\n line 11\n line 12\n line 13',
  ])
})

test('a new file is all additions and a deleted one all removals', () => {
  expect(diffText(null, 'a\nb\nc\n').chunks).toEqual(['@@ -0,0 +1,3 @@\n+a\n+b\n+c'])
  expect(diffText('a\nb\n', null).chunks).toEqual(['@@ -1,2 +0,0 @@\n-a\n-b'])
  expect(diffText(null, '').chunks).toEqual([])
})

test('a line added at the top keeps its context below', () => {
  const diff = diffText('a\nb\nc\nd\ne\n', 'x\na\nb\nc\nd\ne\n')
  expect(diff.chunks).toEqual(['@@ -1,3 +1,4 @@\n+x\n a\n b\n c'])
})

test('changes far apart are two hunks, changes close together are one', () => {
  const far = diffText(numbered(40), numbered(40, n => (n === 5 || n === 35 ? `new ${n}` : null)))
  expect(far.chunks.join('\n').match(/^@@/gm)?.length).toBe(2)
  const near = diffText(numbered(40), numbered(40, n => (n === 5 || n === 10 ? `new ${n}` : null)))
  expect(near.chunks.join('\n').match(/^@@/gm)?.length).toBe(1)
  for (const chunk of [...far.chunks, ...near.chunks]) expectValidHunks(chunk)
})

test('moved and repeated lines still align', () => {
  const before = 'a\nb\nc\na\nb\nc\n'
  const after = 'c\na\nb\nx\nb\nc\n'
  const diff = diffText(before, after)
  for (const chunk of diff.chunks) expectValidHunks(chunk)
  expect(diff.added).toBe(diff.removed)
  expect(diff.added).toBeLessThanOrEqual(3)
})

test('line endings alone make no diff lines', () => {
  const diff = diffText('a\r\nb\r\n', 'a\nb\n')
  expect(diff.added + diff.removed).toBe(0)
  expect(diff.chunks).toEqual([])
})

test('a huge diff is cut into valid chunks under the limits', () => {
  const before = numbered(6000)
  const after = numbered(6000, n => `rewritten ${n} ${'x'.repeat(n % 50)}`)
  const diff = diffText(before, after)
  expect(diff.added).toBe(6000)
  expect(diff.removed).toBe(6000)
  expect(diff.hiddenLines).toBeGreaterThan(0)
  expect(diff.chunks.length).toBeGreaterThan(1)
  let total = 0
  for (const chunk of diff.chunks) {
    expect(chunk.length).toBeLessThanOrEqual(8000)
    expectValidHunks(chunk)
    total += chunk.length
  }
  expect(total).toBeLessThanOrEqual(30_000)
})

test('control characters are drawn as their pictures', () => {
  expect(printable('a\u001b[31mb\u0000c\u007f')).toBe('a␛[31mb␀c␡')
  const diff = diffText('x\n', 'x\u001b\n')
  expect(diff.chunks.join('\n')).toContain('+x␛')
  expect(diff.chunks.join('\n')).not.toContain('\u001b')
})

test('hunks undo back to the text before, keeping CRLF', () => {
  const before = 'one\r\ntwo\r\nthree\r\nfour\r\n'
  const after = 'one\r\nTWO\r\nthree\r\nfour\r\nfive\r\n'
  const hunks: Hunk[] = [
    { oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, lines: [' one', '-two', '+TWO', ' three', ' four', '+five'] },
  ]
  expect(unapply(after, hunks)).toBe(before)
  // A file the hunks do not describe is refused, never guessed.
  expect(unapply('something else\r\n', hunks)).toBeNull()
})

test('hunks undo a deletion and a missing final newline', () => {
  const deleted: Hunk[] = [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-a', '-b'] }]
  expect(unapply('', deleted)).toBe('a\nb\n')
  const noEol: Hunk[] = [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+b'] },
  ]
  expect(unapply('b\n', noEol)).toBe('a')
  const two: Hunk[] = [
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-b', '+B'] },
    { oldStart: 9, oldLines: 1, newStart: 9, newLines: 2, lines: ['-i', '+I', '+J'] },
  ]
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n'
  const after = 'a\nB\nc\nd\ne\nf\ng\nh\nI\nJ\nj\n'
  expect(unapply(after, two)).toBe(before)
})
