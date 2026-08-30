import { readdir, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { spawnSync } from 'node:child_process'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import { jsonParse } from '../utils/slowOperations.js'
import { selectEngine } from './bg/engines/index.js'
import type { BgEngine, SessionEntry } from './bg/engine.js'

export type { SessionEntry } from './bg/engine.js'

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

function getSessionJobsDir(): string {
  return join(getSessionsDir(), 'jobs')
}

async function listStoredJobs(): Promise<SessionEntry[]> {
  let files: string[]
  try {
    files = await readdir(getSessionJobsDir())
  } catch {
    return []
  }

  const jobs: SessionEntry[] = []
  for (const file of files) {
    if (!/^.+\.json$/.test(file)) continue
    try {
      const entry = jsonParse(
        await readFile(join(getSessionJobsDir(), file), 'utf-8'),
      ) as SessionEntry
      if (
        entry &&
        typeof entry.sessionId === 'string' &&
        typeof entry.cwd === 'string'
      ) {
        jobs.push(entry)
      }
    } catch {
      // Corrupt job file — leave it in place for manual recovery.
    }
  }
  return jobs
}

async function getEngineForSession(session: SessionEntry): Promise<BgEngine> {
  const engineType = resolveSessionEngine(session)
  if (engineType === 'tmux') {
    const { TmuxEngine } = await import('./bg/engines/tmux.js')
    const engine = new TmuxEngine()
    if (!(await engine.available())) {
      throw new Error('tmux is no longer available for this session.')
    }
    return engine
  }
  if (engineType === 'pty') {
    const { PtyEngine } = await import('./bg/engines/pty.js')
    const engine = new PtyEngine()
    if (!(await engine.available())) {
      throw new Error('The PTY engine is no longer available for this session.')
    }
    return engine
  }
  const { DetachedEngine } = await import('./bg/engines/detached.js')
  return new DetachedEngine()
}

async function waitForSessionExit(session: SessionEntry): Promise<void> {
  if (resolveSessionEngine(session) === 'tmux') {
    await new Promise(resolve => setTimeout(resolve, 250))
    return
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && isProcessRunning(session.pid)) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export async function listLiveSessions(): Promise<SessionEntry[]> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const sessions: SessionEntry[] = []
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)

    if (!isProcessRunning(pid)) {
      void unlink(join(dir, file)).catch(() => {})
      continue
    }

    try {
      const raw = await readFile(join(dir, file), 'utf-8')
      const entry = jsonParse(raw) as SessionEntry
      sessions.push(entry)
    } catch {
      // Corrupt file — skip
    }
  }

  return sessions
}

export function findSession(
  sessions: SessionEntry[],
  target: string,
): SessionEntry | undefined {
  // Do not let parseInt's prefix parsing turn an invalid target such as
  // `123abc` into a valid PID lookup.
  const asNum = /^\d+$/.test(target) ? Number(target) : Number.NaN
  return sessions.find(
    s =>
      s.sessionId === target ||
      s.pid === asNum ||
      (s.name && s.name === target),
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/**
 * Resolve the engine type for an existing session.
 * Backward-compatible: sessions without an `engine` field are inferred
 * from the presence of `tmuxSessionName`.
 */
function resolveSessionEngine(
  session: SessionEntry,
): 'tmux' | 'detached' | 'pty' {
  if (session.engine) return session.engine
  return session.tmuxSessionName ? 'tmux' : 'detached'
}

/**
 * Stop a background session without ever passing an untrusted/placeholder
 * PID to process.kill(). Tmux sessions are addressed by their tmux name;
 * process.kill(0) would target the current process group and can terminate
 * the CLI that is handling the command.
 */
function signalSession(
  session: SessionEntry,
  signal: NodeJS.Signals,
): { ok: boolean; reason?: string } {
  const engine = resolveSessionEngine(session)

  if (engine === 'tmux' && session.tmuxSessionName) {
    const result = spawnSync(
      'tmux',
      ['kill-session', '-t', session.tmuxSessionName],
      { stdio: 'ignore' },
    )
    if (result.error) return { ok: false, reason: result.error.message }
    return result.status === 0
      ? { ok: true }
      : { ok: false, reason: 'tmux session is no longer available' }
  }

  if (
    !Number.isSafeInteger(session.pid) ||
    session.pid <= 1 ||
    session.pid === process.pid
  ) {
    return { ok: false, reason: `refusing unsafe PID ${String(session.pid)}` }
  }

  try {
    process.kill(session.pid, signal)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * `claude daemon status` / `claude ps` — list live sessions.
 */
export async function psHandler(_args: string[]): Promise<void> {
  const sessions = await listLiveSessions()

  if (sessions.length === 0) {
    console.log('No active sessions.')
    return
  }

  console.log(
    `${sessions.length} active session${sessions.length > 1 ? 's' : ''}:\n`,
  )

  for (const s of sessions) {
    const engineType = resolveSessionEngine(s)
    const parts: string[] = [
      `  PID: ${s.pid}`,
      `  Kind: ${s.kind}`,
      `  Engine: ${engineType}`,
      `  Session: ${s.sessionId}`,
      `  CWD: ${s.cwd}`,
    ]

    if (s.name) parts.push(`  Name: ${s.name}`)
    if (s.startedAt) parts.push(`  Started: ${formatTime(s.startedAt)}`)
    if (s.status) parts.push(`  Status: ${s.status}`)
    if (s.waitingFor) parts.push(`  Waiting for: ${s.waitingFor}`)
    if (s.bridgeSessionId) parts.push(`  Bridge: ${s.bridgeSessionId}`)
    if (s.tmuxSessionName) parts.push(`  Tmux: ${s.tmuxSessionName}`)
    if (s.logPath) parts.push(`  Log: ${s.logPath}`)

    console.log(parts.join('\n'))
    console.log()
  }
}

/**
 * `claude daemon logs <target>` — show logs for a session.
 */
export async function logsHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log('No active sessions.')
      return
    }
    if (sessions.length === 1) {
      target = sessions[0]!.sessionId
    } else {
      console.log('Multiple sessions active. Specify one:')
      for (const s of sessions) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        console.log(`  ${label}  PID=${s.pid}`)
      }
      return
    }
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  if (!session.logPath) {
    console.log(`No log path recorded for session ${session.sessionId}`)
    return
  }

  try {
    const content = await readFile(session.logPath, 'utf-8')
    process.stdout.write(content)
  } catch (e) {
    console.error(`Failed to read log file: ${session.logPath}`)
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

/**
 * `claude daemon attach <target>` — attach to a background session.
 *
 * Engine-aware: tmux sessions use tmux attach, detached sessions use log tail.
 */
export async function attachHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    // Find bg sessions (tmux or detached)
    const bgSessions = sessions.filter(
      s => s.tmuxSessionName || s.engine === 'detached' || s.engine === 'pty',
    )
    if (bgSessions.length === 0) {
      console.log(
        'No background sessions to attach to. Start one with `claude daemon bg`.',
      )
      return
    }
    if (bgSessions.length === 1) {
      target = bgSessions[0]!.sessionId
    } else {
      console.log('Multiple background sessions. Specify one:')
      for (const s of bgSessions) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        const engineType = resolveSessionEngine(s)
        console.log(`  ${label}  PID=${s.pid}  engine=${engineType}`)
      }
      return
    }
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  const engineType = resolveSessionEngine(session)

  try {
    if (engineType === 'tmux') {
      const { TmuxEngine } = await import('./bg/engines/tmux.js')
      const tmux = new TmuxEngine()
      if (!(await tmux.available())) {
        console.error(
          'tmux is no longer available. Cannot attach to tmux session.',
        )
        process.exitCode = 1
        return
      }
      await tmux.attach(session)
    } else if (engineType === 'pty') {
      const { PtyEngine } = await import('./bg/engines/pty.js')
      const pty = new PtyEngine()
      await pty.attach(session)
    } else {
      const { DetachedEngine } = await import('./bg/engines/detached.js')
      const detached = new DetachedEngine()
      await detached.attach(session)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}

/**
 * `claude daemon kill <target>` — kill a session.
 */
export async function killHandler(target: string | undefined): Promise<void> {
  const sessions = await listLiveSessions()

  if (!target) {
    if (sessions.length === 0) {
      console.log('No active sessions to kill.')
      return
    }
    console.log('Specify a session to kill:')
    for (const s of sessions) {
      const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
      console.log(`  ${label}  PID=${s.pid}`)
    }
    return
  }

  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  console.log(`Killing session ${session.sessionId} (PID: ${session.pid})...`)

  const stopped = signalSession(session, 'SIGTERM')
  if (!stopped.ok) {
    if (stopped.reason?.startsWith('refusing unsafe PID')) {
      console.error(`Cannot kill session: ${stopped.reason}`)
      process.exitCode = 1
      return
    }
    console.log('Session already exited.')
    return
  }

  await new Promise(resolve => setTimeout(resolve, 2000))

  if (resolveSessionEngine(session) === 'tmux') {
    // tmux kill-session already tears down the process tree. Avoid probing or
    // signalling the placeholder PID returned by TmuxEngine.start().
    console.log('Session stopped.')
  } else if (isProcessRunning(session.pid)) {
    const forceStopped = signalSession(session, 'SIGKILL')
    if (forceStopped.ok) {
      console.log('Session force-killed.')
    } else {
      console.log('Session exited during grace period.')
    }
  } else {
    console.log('Session stopped.')
  }

  const pidFile = join(getSessionsDir(), `${session.pid}.json`)
  void unlink(pidFile).catch(() => {})
}

/**
 * `claude stop <target>` — gracefully stop a background session.
 *
 * Unlike `kill`, this never escalates to SIGKILL. The child gets a chance to
 * flush its transcript and remove its own registry entry, matching the
 * reference CLI's “conversation is kept” behavior as closely as the dev
 * session registry allows.
 */
export async function stopHandler(target: string | undefined): Promise<void> {
  if (!target) {
    console.error('Usage: claude stop <id>')
    process.exitCode = 1
    return
  }

  const sessions = await listLiveSessions()
  const session = findSession(sessions, target)
  if (!session) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  const result = signalSession(session, 'SIGTERM')
  if (!result.ok) {
    console.error(`Cannot stop session: ${result.reason ?? 'unknown error'}`)
    process.exitCode = 1
    return
  }

  console.log(`stopped ${session.sessionId}`)
  const pidFile = join(getSessionsDir(), `${session.pid}.json`)
  void unlink(pidFile).catch(() => {})
}

/**
 * `claude respawn <id|--all>` — restart background jobs with this binary.
 *
 * Jobs created before launch-argument persistence was added are reported as
 * non-respawnable instead of guessing at a command line. Stored logs and
 * transcripts are intentionally preserved.
 */
export async function respawnHandler(
  target: string | undefined,
): Promise<void> {
  if (!target) {
    console.error('Usage: claude respawn <id|--all>')
    process.exitCode = 1
    return
  }

  const liveSessions = await listLiveSessions()
  const storedJobs = await listStoredJobs()
  const jobs =
    target === '--all'
      ? storedJobs.length > 0
        ? storedJobs
        : liveSessions.filter(s => s.kind === 'bg')
      : [
          liveSessions.find(s => findSession([s], target)) ??
            storedJobs.find(s => findSession([s], target)),
        ].filter((s): s is SessionEntry => s !== undefined)

  if (jobs.length === 0) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  let failures = 0
  for (const job of jobs) {
    if (!job.args) {
      console.error(
        `Cannot respawn ${job.sessionId}: launch arguments were not recorded.`,
      )
      failures++
      continue
    }

    const live = liveSessions.find(
      s =>
        s.sessionId === job.sessionId ||
        (job.name !== undefined && s.name === job.name),
    )
    if (live) {
      const stopped = signalSession(live, 'SIGTERM')
      if (!stopped.ok) {
        console.error(`Cannot stop ${live.sessionId}: ${stopped.reason}`)
        failures++
        continue
      }
      await waitForSessionExit(live)
      if (
        resolveSessionEngine(live) !== 'tmux' &&
        isProcessRunning(live.pid)
      ) {
        const forceStopped = signalSession(live, 'SIGKILL')
        if (!forceStopped.ok) {
          console.error(`Cannot respawn ${live.sessionId}: ${forceStopped.reason}`)
          failures++
          continue
        }
        await waitForSessionExit(live)
      }
      void unlink(join(getSessionsDir(), `${live.pid}.json`)).catch(() => {})
    }

    try {
      const engine = await getEngineForSession(job)
      const sessionName =
        job.name ?? job.tmuxSessionName ?? `claude-bg-${job.sessionId.slice(0, 8)}`
      const logPath =
        job.logPath ?? join(getSessionsDir(), 'logs', `${sessionName}.log`)
      const result = await engine.start({
        sessionName,
        args: job.args,
        env: { ...process.env },
        logPath,
        cwd: job.cwd,
      })
      // The relaunched child receives a fresh session ID and writes a new job
      // record. Retire the old record only after spawn succeeds.
      void unlink(join(getSessionJobsDir(), `${job.sessionId}.json`)).catch(
        () => {},
      )
      console.log(`respawned ${job.sessionId} (${result.engineUsed})`)
    } catch (error) {
      console.error(
        `Failed to respawn ${job.sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      failures++
    }
  }

  if (failures > 0) process.exitCode = 1
}

/**
 * `claude rm <id>` — remove stopped job metadata while retaining logs.
 * Keeping the log is deliberate: unlike a worktree, it is the user's
 * conversation record and can still be inspected or archived manually.
 */
export async function rmHandler(target: string | undefined): Promise<void> {
  if (!target) {
    console.error('Usage: claude rm <id>')
    process.exitCode = 1
    return
  }

  const liveSessions = await listLiveSessions()
  if (findSession(liveSessions, target)) {
    console.error('Session is still active; stop it before removing the job.')
    process.exitCode = 1
    return
  }

  const job = (await listStoredJobs()).find(s => findSession([s], target))
  if (!job) {
    console.error(`Session not found: ${target}`)
    process.exitCode = 1
    return
  }

  try {
    await unlink(join(getSessionJobsDir(), `${job.sessionId}.json`))
    console.log(`removed ${job.sessionId}`)
  } catch (error) {
    console.error(
      `Failed to remove ${job.sessionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exitCode = 1
  }
}

/**
 * `claude daemon bg [args]` — start a background session.
 *
 * Cross-platform: uses TmuxEngine on macOS/Linux when tmux is available,
 * falls back to DetachedEngine on Windows or when tmux is absent.
 */
export async function handleBgStart(args: string[]): Promise<void> {
  const engine = await selectEngine()

  // Strip --bg/--background from args (for backward-compat shortcut)
  const filteredArgs = args.filter(a => a !== '--bg' && a !== '--background')

  // Engines without interactive TTY input (e.g. detached) require -p/--print
  // or piped input. Tmux provides a virtual terminal so it works without -p.
  if (
    !engine.supportsInteractiveInput &&
    !filteredArgs.some(a => a === '-p' || a === '--print' || a === '--pipe')
  ) {
    console.error(
      'Error: Background sessions with detached engine require -p/--print flag.\n' +
        'The detached engine has no terminal for interactive input.\n\n' +
        'Usage:\n' +
        '  claude daemon bg -p "your prompt here"\n' +
        '  echo "prompt" | claude daemon bg --pipe',
    )
    if (process.platform !== 'win32') {
      console.error(
        '\nAlternatively, install tmux for interactive background sessions:\n' +
          `  ${process.platform === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux'}`,
      )
    }
    process.exitCode = 1
    return
  }

  const sessionName = `claude-bg-${randomUUID().slice(0, 8)}`
  const logPath = join(
    getClaudeConfigHomeDir(),
    'sessions',
    'logs',
    `${sessionName}.log`,
  )

  try {
    const result = await engine.start({
      sessionName,
      args: filteredArgs,
      env: { ...process.env },
      logPath,
      cwd: process.cwd(),
    })

    console.log(`Background session started: ${result.sessionName}`)
    console.log(`  Engine: ${result.engineUsed}`)
    console.log(`  Log: ${result.logPath}`)
    console.log()
    console.log(
      `Use \`claude daemon attach ${result.sessionName}\` to reconnect.`,
    )
    console.log(`Use \`claude daemon status\` to check status.`)
    console.log(`Use \`claude daemon kill ${result.sessionName}\` to stop.`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}
