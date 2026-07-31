/**
 * Tests for shadowGit.ts — real git in temp dirs (execFileNoThrow is the IO
 * boundary; mocking it would test nothing). CLAUDE_CONFIG_DIR points at a
 * temp dir so the shadow repos never touch the real ~/.claude.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../tests/mocks/debug'
import { logMock } from '../../../tests/mocks/log'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: async () => {},
}))

import {
  _resetShadowGitForTesting,
  shadowGitChangedFiles,
  shadowGitDiffStats,
  shadowGitRestoreTree,
  shadowGitRevertFiles,
  shadowGitTrack,
} from '../shadowGit'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let workDir = ''
let configDir = ''
let savedConfigDir: string | undefined

async function write(rel: string, content: string) {
  const abs = join(workDir, rel)
  await mkdir(join(abs, '..'), { recursive: true }).catch(() => undefined)
  await writeFile(abs, content)
}

async function read(rel: string): Promise<string> {
  return readFile(join(workDir, rel), 'utf8')
}

beforeEach(async () => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  workDir = await mkdtemp(join(tmpdir(), 'shadow-git-wt-'))
  configDir = await mkdtemp(join(tmpdir(), 'shadow-git-cfg-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  _resetShadowGitForTesting()
  execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' })
})

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(workDir, { recursive: true, force: true })
  await rm(configDir, { recursive: true, force: true })
})

describe('shadowGitTrack', () => {
  test.skipIf(!hasGit)(
    'returns a tree hash and captures worktree state',
    async () => {
      await write('a.txt', 'hello')
      const tree = await shadowGitTrack(workDir)
      expect(tree).toMatch(/^[0-9a-f]{40}$/)
    },
  )

  test.skipIf(!hasGit)('returns null for a non-git directory', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'shadow-git-plain-'))
    try {
      expect(await shadowGitTrack(plain)).toBeNull()
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  test.skipIf(!hasGit)(
    'debounce reuses the previous tree within 1.5s',
    async () => {
      await write('a.txt', 'one')
      const first = await shadowGitTrack(workDir)
      await write('a.txt', 'two')
      const second = await shadowGitTrack(workDir)
      expect(second).toBe(first)
      _resetShadowGitForTesting()
      const third = await shadowGitTrack(workDir)
      expect(third).not.toBe(first)
    },
  )
})

describe('changed files + revert', () => {
  test.skipIf(!hasGit)(
    'revert restores modified files and deletes new ones',
    async () => {
      await write('a.txt', 'original')
      const before = await shadowGitTrack(workDir)
      expect(before).not.toBeNull()

      await write('a.txt', 'modified')
      await write('new.txt', 'brand new')
      _resetShadowGitForTesting() // bypass debounce
      const now = await shadowGitTrack(workDir)
      expect(now).not.toBeNull()
      expect(now).not.toBe(before)

      const changed = await shadowGitChangedFiles(workDir, before!, now!)
      expect(changed).toContain('a.txt')
      expect(changed).toContain('new.txt')

      await shadowGitRevertFiles(workDir, before!, changed!)
      expect(await read('a.txt')).toBe('original')
      await expect(read('new.txt')).rejects.toThrow()
    },
  )

  test.skipIf(!hasGit)('gitignored files never enter snapshots', async () => {
    await write('.gitignore', 'ignored.txt\n')
    await write('ignored.txt', 'v1')
    await write('tracked.txt', 'v1')
    const before = await shadowGitTrack(workDir)

    await write('ignored.txt', 'v2')
    await write('tracked.txt', 'v2')
    _resetShadowGitForTesting()
    const now = await shadowGitTrack(workDir)

    const changed = await shadowGitChangedFiles(workDir, before!, now!)
    expect(changed).toContain('tracked.txt')
    expect(changed).not.toContain('ignored.txt')
  })

  test.skipIf(!hasGit)(
    'untracked files over 2MB are excluded from snapshots',
    async () => {
      await write('big.bin', 'x'.repeat(2 * 1024 * 1024 + 1))
      await write('small.txt', 'v1')
      const before = await shadowGitTrack(workDir)
      expect(before).not.toBeNull()

      _resetShadowGitForTesting()
      await write('big.bin', 'y'.repeat(2 * 1024 * 1024 + 1))
      await write('small.txt', 'v2')
      const now = await shadowGitTrack(workDir)

      const changed = await shadowGitChangedFiles(workDir, before!, now!)
      expect(changed).toContain('small.txt')
      expect(changed).not.toContain('big.bin')
    },
  )
})

describe('shadowGitDiffStats / shadowGitRestoreTree', () => {
  test.skipIf(!hasGit)(
    'diff stats count worktree changes against the snapshot',
    async () => {
      await write('a.txt', 'line1\nline2\n')
      const before = await shadowGitTrack(workDir)
      await write('a.txt', 'line1\nline2\nline3\n')

      const stats = await shadowGitDiffStats(workDir, before!)
      expect(stats).not.toBeNull()
      expect(stats!.filesChanged).toContain('a.txt')
      expect(stats!.insertions).toBe(1)
      expect(stats!.deletions).toBe(0)
    },
  )

  test.skipIf(!hasGit)(
    'restoreTree rolls the whole worktree back (redo)',
    async () => {
      await write('a.txt', 'original')
      const before = await shadowGitTrack(workDir)
      await write('a.txt', 'modified')
      await write('b.txt', 'also modified later')

      const ok = await shadowGitRestoreTree(workDir, before!)
      expect(ok).toBe(true)
      expect(await read('a.txt')).toBe('original')
    },
  )
})
