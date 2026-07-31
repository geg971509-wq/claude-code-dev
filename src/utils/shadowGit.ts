import { createHash } from 'crypto'
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'

/**
 * Shadow-git worktree snapshots (borrowed from opencode's snapshot/index.ts).
 *
 * A second git repository per worktree (`--git-dir <shadow> --work-tree
 * <cwd>`) lets us snapshot the ENTIRE worktree as a content-addressed tree
 * hash (`git write-tree`) — no commits, no refs; trees survive via
 * `gc --prune=7.days`. This covers every write (FileEdit, Bash redirects,
 * cp/rm, code generators) instead of intercepting individual tool calls.
 *
 * Everything here soft-fails to null: non-git directory, missing git
 * binary, timeouts, gc'd trees — callers fall back to the legacy per-file
 * backup path in fileHistory.ts.
 *
 * Semantics note: reverting to a tree restores files that changed in the
 * worktree SINCE the snapshot, regardless of who wrote them (agent or
 * user) — same trade-off opencode makes.
 */

const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024
const TRACK_DEBOUNCE_MS = 1_500
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000

export type ShadowDiffStats = {
  filesChanged: string[]
  insertions: number
  deletions: number
}

function getClaudeConfigHomeDirLocal(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  ).normalize('NFC')
}

export function shadowGitDir(cwd: string): string {
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return join(getClaudeConfigHomeDirLocal(), 'shadow-git', key)
}

// ---------------------------------------------------------------------------
// Per-gitdir serialization + lazy init
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>()
const initedOk = new Set<string>()
const initedFailed = new Set<string>()
const lastTrack = new Map<string, { time: number; tree: string }>()

function withLock<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(gitDir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(
    gitDir,
    next.catch(() => undefined),
  )
  return next
}

async function git(
  cwd: string,
  gitDir: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string } | null> {
  const res = await execFileNoThrowWithCwd(
    gitExe(),
    ['--git-dir', gitDir, '--work-tree', cwd, ...args],
    {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      cwd,
      preserveOutputOnError: true,
      ...(input !== undefined ? { input, stdin: 'pipe' as const } : {}),
    },
  )
  if (res.code !== 0) {
    if (res.error?.includes('timed out')) {
      logEvent('tengu_shadow_git_timeout', {})
    }
    logForDebugging(`shadow-git: ${args[0]} failed (code ${res.code})`)
    return null
  }
  return res
}

/** Plain git against the SOURCE repo (no shadow --git-dir). */
async function gitSource(
  cwd: string,
  args: string[],
): Promise<{ stdout: string } | null> {
  const res = await execFileNoThrowWithCwd(gitExe(), ['-C', cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    cwd,
    preserveOutputOnError: true,
  })
  return res.code === 0 ? res : null
}

async function ensureInit(cwd: string, gitDir: string): Promise<boolean> {
  if (initedOk.has(gitDir)) return true
  if (initedFailed.has(gitDir)) return false

  const inside = await gitSource(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside?.stdout.trim() !== 'true') {
    initedFailed.add(gitDir)
    return false
  }

  await mkdir(join(gitDir, 'info'), { recursive: true })
  await mkdir(join(gitDir, 'objects', 'info'), { recursive: true })
  if (!(await git(cwd, gitDir, ['init']))) {
    initedFailed.add(gitDir)
    return false
  }
  for (const [key, value] of [
    ['core.autocrlf', 'false'],
    ['core.quotepath', 'false'],
    ['core.longpaths', 'true'],
    ['core.symlinks', 'true'],
  ]) {
    await git(cwd, gitDir, ['config', key, value])
  }

  // Copy the source repo's exclude rules so ignored files (node_modules,
  // build output) stay out of snapshots.
  const excludePath = await gitSource(cwd, [
    'rev-parse',
    '--git-path',
    'info/exclude',
  ])
  if (excludePath) {
    const sourceExclude = excludePath.stdout.trim()
    const content = await readFile(join(cwd, sourceExclude), 'utf8').catch(() =>
      readFile(sourceExclude, 'utf8').catch(() => null as string | null),
    )
    if (typeof content === 'string') {
      await writeFile(join(gitDir, 'info', 'exclude'), content).catch(
        () => undefined,
      )
    }
  }

  // Reuse the source repo's object database via alternates — on huge repos
  // this avoids re-hashing every unchanged file on the first track.
  const commonDir = await gitSource(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (commonDir) {
    const objectsDir = join(commonDir.stdout.trim(), 'objects').replaceAll(
      '\\',
      '/',
    )
    await writeFile(
      join(gitDir, 'objects', 'info', 'alternates'),
      objectsDir,
    ).catch(() => undefined)
  }

  initedOk.add(gitDir)
  void shadowGitMaybeGc(cwd, gitDir)
  return true
}

async function shadowGitMaybeGc(cwd: string, gitDir: string): Promise<void> {
  const marker = join(gitDir, 'last-gc')
  const markerStat = await stat(marker).catch(() => undefined)
  if (markerStat && Date.now() - markerStat.mtimeMs < GC_INTERVAL_MS) return
  await writeFile(marker, String(Date.now())).catch(() => undefined)
  await git(cwd, gitDir, ['gc', '--prune=7.days'])
}

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stage the current worktree state and return its tree hash, or null on any
 * failure (non-git directory, git missing, timeout). Debounced: a track
 * within TRACK_DEBOUNCE_MS of the previous one reuses its tree hash.
 */
export async function shadowGitTrack(cwd: string): Promise<string | null> {
  const gitDir = shadowGitDir(cwd)
  return withLock(gitDir, async () => {
    const last = lastTrack.get(gitDir)
    if (last && Date.now() - last.time < TRACK_DEBOUNCE_MS) {
      return last.tree
    }
    if (!(await ensureInit(cwd, gitDir))) return null

    const start = Date.now()
    const [modified, untracked] = await Promise.all([
      git(cwd, gitDir, ['diff-files', '--name-only', '-z', '--', '.']),
      git(cwd, gitDir, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        '.',
      ]),
    ])
    if (!modified || !untracked) return null

    const modifiedFiles = splitNul(modified.stdout)
    const untrackedFiles = splitNul(untracked.stdout)

    // Block large NEW files from snapshots (tracked ones must stay — their
    // blobs are already in the object db, dropping them corrupts the tree).
    const stage: string[] = [...modifiedFiles]
    for (const file of untrackedFiles) {
      const fileStat = await stat(join(cwd, file)).catch(() => undefined)
      if (fileStat && fileStat.size > MAX_UNTRACKED_FILE_BYTES) {
        await appendFile(join(gitDir, 'info', 'exclude'), `\n/${file}`).catch(
          () => undefined,
        )
        continue
      }
      stage.push(file)
    }

    if (stage.length > 0) {
      const pathspec = stage.map(f => `:(top,literal)${f}`).join('\0')
      const added = await git(
        cwd,
        gitDir,
        [
          'add',
          '--all',
          '--sparse',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        pathspec,
      )
      if (!added) return null
    }

    const tree = await git(cwd, gitDir, ['write-tree'])
    if (!tree) return null
    const hash = tree.stdout.trim()
    lastTrack.set(gitDir, { time: Date.now(), tree: hash })
    logEvent('tengu_shadow_git_track', {
      durationMs: Date.now() - start,
      stagedFiles: stage.length,
    })
    return hash
  })
}

/** Files that differ between two trees (NUL-separated diff --name-only). */
export async function shadowGitChangedFiles(
  cwd: string,
  fromTree: string,
  toTree: string,
): Promise<string[] | null> {
  const gitDir = shadowGitDir(cwd)
  const res = await git(cwd, gitDir, [
    'diff',
    '--name-only',
    '-z',
    fromTree,
    toTree,
  ])
  return res ? splitNul(res.stdout) : null
}

/** numstat of the worktree against a snapshot tree — feeds the rewind UI. */
export async function shadowGitDiffStats(
  cwd: string,
  targetTree: string,
): Promise<ShadowDiffStats | null> {
  const gitDir = shadowGitDir(cwd)
  const res = await git(cwd, gitDir, ['diff', '--numstat', '-z', targetTree])
  if (!res) return null
  const stats: ShadowDiffStats = {
    filesChanged: [],
    insertions: 0,
    deletions: 0,
  }
  const segments = res.stdout.split('\0')
  for (let i = 0; i < segments.length; i++) {
    const match = segments[i]!.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s)
    if (!match) continue
    let path = match[3]!
    if (path === '') {
      // Rename entry: path arrives as the next NUL segment.
      path = segments[++i] ?? ''
    }
    if (!path) continue
    stats.filesChanged.push(path)
    if (match[1] !== '-') stats.insertions += Number(match[1])
    if (match[2] !== '-') stats.deletions += Number(match[2])
  }
  return stats
}

/**
 * Restore the given files to their state in targetTree. Files absent from
 * the tree were created after the snapshot and are deleted. A failed
 * checkout leaves the current file alone (conservative — never destroy
 * work we don't understand).
 */
export async function shadowGitRevertFiles(
  cwd: string,
  targetTree: string,
  files: string[],
): Promise<boolean> {
  const gitDir = shadowGitDir(cwd)
  return withLock(gitDir, async () => {
    for (const file of files) {
      const checkout = await git(cwd, gitDir, [
        'checkout',
        targetTree,
        '--',
        file,
      ])
      if (checkout) continue
      const lsTree = await git(cwd, gitDir, ['ls-tree', targetTree, '--', file])
      if (lsTree && lsTree.stdout.trim() === '') {
        // Not in the snapshot tree → created after the snapshot → delete.
        await rm(join(cwd, file), { force: true }).catch(() => undefined)
      }
      // ls-tree says the file existed but checkout failed → keep current.
    }
    return true
  })
}

/** Restore the ENTIRE worktree to a tree (redo of a previous rewind). */
export async function shadowGitRestoreTree(
  cwd: string,
  tree: string,
): Promise<boolean> {
  const gitDir = shadowGitDir(cwd)
  return withLock(gitDir, async () => {
    if (!(await git(cwd, gitDir, ['read-tree', tree]))) return false
    return (await git(cwd, gitDir, ['checkout-index', '-a', '-f'])) !== null
  })
}

/** Test-only: clear module-level init/debounce state. */
export function _resetShadowGitForTesting(): void {
  locks.clear()
  initedOk.clear()
  initedFailed.clear()
  lastTrack.clear()
}
