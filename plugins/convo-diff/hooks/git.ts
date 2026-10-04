// Snapshots of the work tree, for the commands whose record names no files (PowerShell's; Bash's carries the
// engine's bashEditDiff). Git hashes the work tree into an index of this plugin's own, never the repo's,
// `write-tree` names the result, and `diff-tree` lists the files that differ between two of them, with each
// file's blob before. What reads git's answers lives here; the calls themselves, which need `$`, in register.

// One file a command changed: its path from the repo's top, and its blob before (null: it did not exist).
export type Changed = { rel: string; before: string | null }

const DAY_MS = 24 * 3600_000
const INDEX_NAME = /^convo-diff-[0-9a-z]+\.index(\.lock)?$/

// Its CRLF warnings off: they say nothing a snapshot needs.
export function gitArgv(args: readonly string[]): string[] {
  return ['git', '-c', 'core.safecrlf=false', ...args]
}

// Regular files only: a link or a submodule has no text to compare.
function isFile(mode: string): boolean {
  return mode === '100644' || mode === '100755'
}

// `git diff-tree -r -z --raw`: `:<old mode> <new mode> <old blob> <new blob> <status>`, NUL, the path, NUL; per file.
export function parseRaw(out: string): Changed[] {
  const parts = out.split('\0')
  const changed: Changed[] = []
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const head = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(parts[index] ?? '')
    const rel = parts[index + 1] ?? ''
    if (head === null || rel === '') continue
    const [, oldMode = '', newMode = '', oldBlob = ''] = head
    if (!isFile(oldMode) && !isFile(newMode)) continue
    changed.push({ rel, before: isFile(oldMode) ? oldBlob : null })
  }
  return changed
}

// A blob holds what git stored (core.autocrlf stores CRLF as LF): written back, it takes the file's line endings now.
export function withEol(text: string, like: string): string {
  return like.includes('\r\n') && !text.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text
}

// An index an earlier session left: a session rewrites its own with every snapshot, so a day untouched is a leftover.
// One removed from under a live session only makes its next snapshot hash every file again.
export function isLeftover(name: string, mtimeMs: number, now: number): boolean {
  return INDEX_NAME.test(name) && now - mtimeMs > DAY_MS
}
