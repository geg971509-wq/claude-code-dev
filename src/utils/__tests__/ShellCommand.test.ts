import { type ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, mock, test } from 'bun:test'

import { debugMock } from '../../../tests/mocks/debug'
import { logMock } from '../../../tests/mocks/log'

// Mock dependencies before importing the module under test
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({
  feature: () => false,
}))
mock.module('src/bootstrap/state.ts', () => ({
  getSessionId: () => 'test-session-shellcommand',
  getIsNonInteractiveSession: () => false,
  getOriginalCwd: () => process.cwd(),
}))

import { generateTaskId } from '../../Task.js'
import { wrapSpawn } from '../ShellCommand.js'
import { TaskOutput } from '../task/TaskOutput.js'

// Mirrors SIGTERM_GRACE_MS in ShellCommand.ts (not exported). Tests only
// assert loose bounds around it: "still alive well before" and "dead only
// after most of the grace period has elapsed".
const GRACE_MS = 1_500

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => resolve())
  })
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) {
      return true
    }
    await sleep(50)
  }
  return cond()
}

function spawnWrapped(script: string, timeout = 60_000) {
  const child = spawn('bash', ['-c', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const controller = new AbortController()
  const cmd = wrapSpawn(
    child,
    controller.signal,
    timeout,
    new TaskOutput(generateTaskId('local_bash'), null),
  )
  return { child, controller, cmd }
}

describe('ShellCommand kill (two-phase SIGTERM → SIGKILL)', () => {
  test('delivers SIGTERM first while reporting the nominal SIGKILL code immediately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shellcmd-'))
    const marker = join(dir, 'term-received')
    // The trap only runs on SIGTERM — SIGKILL cannot be trapped, so the
    // marker proves the process got a chance to shut down gracefully.
    const { child, cmd } = spawnWrapped(
      `trap 'echo term > "${marker}"; exit 0' TERM; sleep 60`,
    )
    try {
      await sleep(200) // let bash install the trap
      cmd.kill()
      // Nominal behavior is unchanged: the result resolves right away with
      // the SIGKILL code, without waiting out the grace period.
      const result = await cmd.result
      expect(result.code).toBe(137)
      expect(result.interrupted).toBe(true)

      expect(await waitFor(() => existsSync(marker))).toBe(true)
      await waitForExit(child)
    } finally {
      cmd.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('escalates to SIGKILL when the process ignores SIGTERM past the grace period', async () => {
    const { child, cmd } = spawnWrapped(
      'trap "" TERM; while :; do sleep 0.2; done',
    )
    const pid = child.pid!
    try {
      await sleep(200)
      const killedAt = Date.now()
      cmd.kill()
      await cmd.result

      // Well inside the grace period: still alive — SIGKILL was NOT sent
      // immediately (the pre-change behavior).
      await sleep(300)
      expect(isAlive(pid)).toBe(true)

      // The escalation reaps it only after the grace period elapses.
      await waitForExit(child)
      expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1_000)
      expect(await waitFor(() => !isAlive(pid))).toBe(true)
    } finally {
      cmd.cleanup()
      if (isAlive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    }
  })

  test('timeout keeps the nominal SIGTERM exit code and timed-out message', async () => {
    const { child, cmd } = spawnWrapped(
      'trap "" TERM; while :; do sleep 0.2; done',
      200,
    )
    const pid = child.pid!
    try {
      const result = await cmd.result
      expect(result.code).toBe(143)
      expect(result.stderr).toContain('Command timed out')
      // The SIGTERM-ignoring process is still reaped by the escalation.
      await waitForExit(child)
    } finally {
      cmd.cleanup()
      if (isAlive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    }
  })

  test("abort('interrupt') leaves the process running", async () => {
    const { child, controller, cmd } = spawnWrapped('sleep 60')
    const pid = child.pid!
    try {
      await sleep(200)
      controller.abort('interrupt')
      await sleep(200)
      expect(cmd.status).toBe('running')
      expect(isAlive(pid)).toBe(true)
    } finally {
      cmd.kill()
      await cmd.result
      await waitForExit(child)
      cmd.cleanup()
      if (isAlive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    }
  })
})
