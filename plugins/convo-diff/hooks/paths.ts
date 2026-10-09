// Paths as the file tools, git and the shells spell them, folded to one spelling to compare.

export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path)
}

export function absolute(path: string, cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path)) return path
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`
}

// An MSYS git, or Git Bash, spells D:\x as /d/x: back to d:/x where `like` is spelled with a drive.
export function fromMsys(path: string, like: string): string {
  const msys = /^\/([A-Za-z])(\/.*)?$/.exec(path)
  return msys !== null && /^[A-Za-z]:/.test(like) ? `${msys[1]}:${msys[2] ?? '/'}` : path
}

// Forward slashes, `.` and `..` folded.
export function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const head = /^[A-Za-z]:\//.test(slashed)
    ? slashed.slice(0, 3)
    : slashed.startsWith('//')
      ? '//'
      : slashed.startsWith('/')
        ? '/'
        : ''
  const parts: string[] = []
  for (const part of slashed.slice(head.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return head + parts.join('/')
}

// One spelling per file: Windows paths ignore case.
export function keyOf(path: string): string {
  const normal = normalize(path)
  return isWindowsPath(path) ? normal.toLowerCase() : normal
}

// The path inside the repo, or null for a file outside it.
export function relOf(path: string, top: string): string | null {
  const normal = normalize(path)
  const base = normalize(top).replace(/\/$/, '')
  const fold = (text: string) => (isWindowsPath(top) ? text.toLowerCase() : text)
  return fold(normal).startsWith(`${fold(base)}/`) ? normal.slice(base.length + 1) : null
}
