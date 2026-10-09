import { expect, test } from 'claude-code/testing'

import { ALLOW, commandsOf, gitOpsOf, isAllowed, parseStatus, takesFile } from '../hooks/clash'
import type { Dirty, Shell } from '../hooks/clash'

const TOP = 'D:/proj'

function kinds(line: string, shell: Shell = 'bash'): string[] {
  return gitOpsOf(line, shell, TOP).map(op => `${op.kind} ${op.text}`)
}

function file(rel: string, kind: 'worktree' | 'index' | 'untracked' = 'worktree'): Dirty {
  return { rel, worktree: kind === 'worktree', index: kind === 'index', untracked: kind === 'untracked' }
}

// Whether the line, run in `cwd`, takes this file's changes of that kind.
function takes(line: string, rel: string, kind: 'worktree' | 'index' | 'untracked' = 'worktree', cwd = TOP, shell: Shell = 'bash'): boolean {
  return gitOpsOf(line, shell, cwd).some(op => takesFile(op, file(rel, kind), TOP))
}

test('a command line splits into its commands with the quotes off', () => {
  expect(commandsOf('git add -A && git commit -m "fix: a; b" && git push', 'bash')).toEqual([
    ['git', 'add', '-A'],
    ['git', 'commit', '-m', 'fix: a; b'],
    ['git', 'push'],
  ])
  expect(commandsOf('git add -A; git commit -m "x" || echo failed | tee log', 'powershell')).toEqual([
    ['git', 'add', '-A'],
    ['git', 'commit', '-m', 'x'],
    ['echo', 'failed'],
    ['tee', 'log'],
  ])
  // Bash escapes with a backslash, PowerShell with a backtick: there a backslash is a path's.
  expect(commandsOf('git add my\\ file.txt "a \\"b\\".txt"', 'bash')).toEqual([['git', 'add', 'my file.txt', 'a "b".txt']])
  expect(commandsOf("git add D:\\proj\\a.txt 'it''s.txt' \"say `\"hi`\"\"", 'powershell')).toEqual([
    ['git', 'add', 'D:\\proj\\a.txt', "it's.txt", 'say "hi"'],
  ])
})

test('a commit message is never read as commands: heredocs, here-strings, substitutions', () => {
  // A heredoc inside a substitution: quotes, parens and all, its body is the message.
  const words = commandsOf(
    `git add a.ts && git commit -m "$(cat <<'EOF'\nfix "quoted" (and parens)\ngit reset --hard\nEOF\n)" && git push`,
    'bash',
  )
  expect(words.map(command => command.slice(0, 2))).toEqual([
    ['git', 'add'],
    ['git', 'commit'],
    ['git', 'push'],
  ])
  expect(words[1]?.[3]).toContain('git reset --hard')
  // A heredoc fed to a command: its body is skipped, and the line after it runs.
  expect(commandsOf("git commit -F - <<'EOF'\ngit add -A\nEOF\ngit status", 'bash')).toEqual([
    ['git', 'commit', '-F', '-'],
    ['git', 'status'],
  ])
  expect(commandsOf('cat <<-END | git apply\n\tgit clean -fd\n\tEND\ngit status', 'bash')).toEqual([
    ['cat'],
    ['git', 'apply'],
    ['git', 'status'],
  ])
  // PowerShell's here-strings.
  expect(commandsOf("git commit -m @'\ngit clean -fd\n'@\ngit push", 'powershell')).toEqual([
    ['git', 'commit', '-m', 'git clean -fd'],
    ['git', 'push'],
  ])
  expect(commandsOf('git commit -m @"\nreset `$x\n"@; git push', 'powershell')[1]).toEqual(['git', 'push'])
})

test('comments, redirections and their targets are no words', () => {
  expect(commandsOf('git status 2>&1 >/dev/null # git add -A', 'bash')).toEqual([['git', 'status']])
  expect(commandsOf('git diff > out.patch && git log >> log.txt 2> err.txt', 'bash')).toEqual([
    ['git', 'diff'],
    ['git', 'log'],
  ])
  expect(commandsOf('git add . *> $null; & git status <# git stash #>', 'powershell')).toEqual([
    ['git', 'add', '.'],
    ['git', 'status'],
  ])
  expect(commandsOf('git apply <<< "$patch"', 'bash')).toEqual([['git', 'apply']])
})

test('the git commands that stage or throw away changes are found, and only those', () => {
  expect(kinds('git add -A && git commit -m "x" && git push origin main')).toEqual(['stage git add -A', 'stage git commit -m'])
  expect(kinds('git commit -am "fix it"')).toEqual(['stage git commit -am'])
  expect(kinds('git checkout -- . ; git restore src ; git reset --hard HEAD~1')).toEqual([
    'discard git checkout -- .',
    'discard git restore src',
    'discard git reset --hard HEAD~1',
  ])
  expect(kinds('git stash -u && git clean -fd && git rm -r old && git rm --cached secret.txt')).toEqual([
    'discard git stash -u',
    'discard git clean -fd',
    'discard git rm -r old',
    'stage git rm --cached secret.txt',
  ])
  expect(kinds('git switch --discard-changes main; git checkout -f main', 'powershell')).toEqual([
    'discard git switch --discard-changes main',
    'discard git checkout -f main',
  ])
  expect(kinds('GIT_EDITOR=true git -c core.autocrlf=false --no-pager stash push -m wip -- a.ts')).toEqual([
    'discard git stash push -m -- a.ts',
  ])
  expect(kinds("& 'C:\\Program Files\\Git\\cmd\\git.exe' add .", 'powershell')).toEqual(['stage git add .'])
  // Reading, unstaging, a branch of its own, a stash brought back, a dry run: nothing taken.
  for (const line of [
    'git status',
    'git diff HEAD',
    'git log --oneline -5',
    'git add',
    'git add -n .',
    'git checkout -b feature',
    'git restore --staged a.ts',
    'git reset',
    'git reset HEAD a.ts',
    'git stash pop',
    'git stash list',
    'git clean -n',
    'git commit --dry-run -a',
    'git push --force',
    'gitk',
    'echo git add -A',
  ]) {
    expect(kinds(line)).toEqual([])
  }
})

test('a cd and git -C move where git runs; a folder the line cannot tell leaves git out', () => {
  const where = (line: string, shell: Shell = 'bash') => gitOpsOf(line, shell, TOP).map(op => op.cwd)
  expect(where('cd sub && git add .')).toEqual(['D:/proj/sub'])
  expect(where('Set-Location -Path D:\\proj\\sub; git add .', 'powershell')).toEqual(['D:/proj/sub'])
  expect(where('cd /d/proj/sub && git add .')).toEqual(['d:/proj/sub'])
  expect(where('git -C ../other add -A')).toEqual(['D:/other'])
  expect(where('cd "$REPO" && git add -A')).toEqual([])
  expect(where('cd - && git add -A')).toEqual([])
  expect(where('git --git-dir=/x/.git add -A')).toEqual([])
})

test('git status says which files are changed in the work tree, staged, or not tracked', () => {
  const out = [' M src/a.ts', 'M  staged.ts', 'MM both.ts', '?? new dir/新的.ts', 'R  moved.ts', 'was.ts', 'D  gone.ts', ''].join('\0')
  expect(parseStatus(out)).toEqual([
    { rel: 'src/a.ts', worktree: true, index: false, untracked: false },
    { rel: 'staged.ts', worktree: false, index: true, untracked: false },
    { rel: 'both.ts', worktree: true, index: true, untracked: false },
    { rel: 'new dir/新的.ts', worktree: false, index: false, untracked: true },
    { rel: 'moved.ts', worktree: false, index: true, untracked: false },
    { rel: 'was.ts', worktree: false, index: true, untracked: false },
    { rel: 'gone.ts', worktree: false, index: true, untracked: false },
  ])
})

test('pathspecs take what git would: the folder it runs in, folders, globs, the top and exclusions', () => {
  // The whole repo, wherever it runs.
  expect(takes('git add -A', 'b/x.ts', 'worktree', 'D:/proj/a')).toBe(true)
  // `.` is the folder it runs in.
  expect(takes('git add .', 'b/x.ts', 'worktree', 'D:/proj/a')).toBe(false)
  expect(takes('git add .', 'a/x.ts', 'worktree', 'D:/proj/a')).toBe(true)
  expect(takes('cd a && git add .', 'a/deep/x.ts')).toBe(true)
  // A folder, a file, spelled in another case on Windows or as a full path.
  expect(takes('git add src', 'src/deep/x.ts')).toBe(true)
  expect(takes('git add src', 'srcs/x.ts')).toBe(false)
  expect(takes('git add SRC/X.ts', 'src/x.ts')).toBe(true)
  expect(takes('git add D:\\proj\\src\\x.ts', 'src/x.ts', 'worktree', TOP, 'powershell')).toBe(true)
  // Globs match across folders, as git's do.
  expect(takes("git add '*.md'", 'docs/deep/readme.md')).toBe(true)
  expect(takes("git add '*.md'", 'docs/a.ts')).toBe(false)
  // The top, and exclusions.
  expect(takes('git add :/', 'b/x.ts', 'worktree', 'D:/proj/a')).toBe(true)
  expect(takes("git add -A -- . ':!b.ts'", 'b.ts')).toBe(false)
  expect(takes("git add -A -- . ':!b.ts'", 'c.ts')).toBe(true)
  expect(takes("git add -A ':(exclude)docs'", 'docs/a.md')).toBe(false)
  expect(takes("git add -A ':(exclude)docs'", 'src/a.ts')).toBe(true)
  // A path outside the repo takes nothing in it.
  expect(takes('git add ../other/x.ts', 'x.ts')).toBe(false)
})

test('each command takes only the kinds of changes it does', () => {
  // git add -u leaves new files alone; git add -A takes them.
  expect(takes('git add -u', 'new.ts', 'untracked')).toBe(false)
  expect(takes('git add -A', 'new.ts', 'untracked')).toBe(true)
  // A plain commit takes what is staged; -a also every tracked change, never a new file.
  expect(takes('git commit -m x', 'a.ts', 'worktree')).toBe(false)
  expect(takes('git commit -m x', 'a.ts', 'index')).toBe(true)
  expect(takes('git commit -am x', 'a.ts', 'worktree')).toBe(true)
  expect(takes('git commit -am x', 'new.ts', 'untracked')).toBe(false)
  // Paths after the message commit only those paths, whatever else is staged.
  expect(takes('git commit -m x -- a.ts', 'b.ts', 'index')).toBe(false)
  expect(takes('git commit -m x -- a.ts', 'a.ts', 'worktree')).toBe(true)
  // Checking out from the index loses only the work tree's changes; from a commit, what is staged too.
  expect(takes('git checkout -- a.ts', 'a.ts', 'index')).toBe(false)
  expect(takes('git checkout HEAD -- a.ts', 'a.ts', 'index')).toBe(true)
  // reset --hard and stash take every tracked change; clean only what git does not track.
  expect(takes('git reset --hard', 'a.ts', 'index')).toBe(true)
  expect(takes('git reset --hard', 'new.ts', 'untracked')).toBe(false)
  expect(takes('git stash', 'new.ts', 'untracked')).toBe(false)
  expect(takes('git stash -u', 'new.ts', 'untracked')).toBe(true)
  expect(takes('git clean -fd', 'new.ts', 'untracked')).toBe(true)
  expect(takes('git clean -fd', 'a.ts', 'worktree')).toBe(false)
  // A branch read as a path names no file.
  expect(takes('git checkout main', 'a.ts')).toBe(false)
  expect(takes('git checkout a.ts', 'a.ts')).toBe(true)
})

test('the mark that lets a command through is a comment in both shells', () => {
  const line = `git add -A ${ALLOW}`
  expect(isAllowed(line)).toBe(true)
  expect(isAllowed('git add -A')).toBe(false)
  expect(commandsOf(line, 'bash')).toEqual([['git', 'add', '-A']])
  expect(commandsOf(line, 'powershell')).toEqual([['git', 'add', '-A']])
})
