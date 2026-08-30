import { readdir, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { spawnSync } from 'node:child_process'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import { jsonParse } from '../utils/slowOperations.js'
import { peekForStdinData } from '../utils/process.js'
import { selectEngine } from './bg/engines/index.js'
import type { BgEngine, SessionEntry } from './bg/engine.js'
import {
  formatJobTargetError,
  listJobRecords,
  removeJobRecord,
  resolveJobTarget,
  writeJobRecord,
  type BgJobRecord,
  type BgLaunch,
} from './bg/jobStore.js'

export type { SessionEntry } from './bg/engine.js'

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

async function listStoredJobs(): Promise<BgJobRecord[]> {
  return listJobRecords()
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
  while (Date.now() < deadline && isManagedProcessRunning(session)) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function isManagedProcessRunning(
  session: Pick<SessionEntry, 'pid' | 'launch'>,
): boolean {
  if (
    process.platform !== 'win32' &&
    session.launch?.mode === 'exec' &&
    Number.isSafeInteger(session.pid) &&
    session.pid > 1
  ) {
    try {
      process.kill(-session.pid, 0)
      return true
    } catch {
      return false
    }
  }
  return Number.isSafeInteger(session.pid) && session.pid > 1 && isProcessRunning(session.pid)
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

  // `--exec` has no Claude child to write the normal PID registry file. Use
  // the durable job record as the source of truth for those sessions (and as
  // a short startup bridge for tmux-backed Claude jobs).
  const storedJobs = await listStoredJobs()
  for (const job of storedJobs) {
    if (sessions.some(session => session.sessionId === job.sessionId)) continue
    const live =
      resolveSessionEngine(job) === 'tmux' && job.tmuxSessionName
        ? spawnSync('tmux', ['has-session', '-t', job.tmuxSessionName], {
            stdio: 'ignore',
          }).status === 0
        : isManagedProcessRunning(job)
    if (live) sessions.push(job)
    else if (
      job.status === 'starting' ||
      job.status === 'running' ||
      job.status === 'idle' ||
      job.status === 'waiting'
    )
      void writeJobRecord({ ...job, status: 'exited', updatedAt: Date.now() }).catch(() => {})
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
      s.jobId === target ||
      s.jobId?.startsWith(target) ||
      s.sessionId.startsWith(target) ||
      s.pid === asNum ||
      (s.name && s.name === target),
  )
}

/** Resolve a live/stored session with the reference's unique-prefix rules. */
function resolveSessionTarget(
  sessions: SessionEntry[],
  target: string,
): SessionEntry | undefined {
  const resolved = resolveJobTarget(sessions as BgJobRecord[], target)
  if ('sessionId' in resolved) return resolved
  console.error(formatJobTargetError(resolved))
  process.exitCode = 1
  return undefined
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
    const targetPid =
      process.platform !== 'win32' && session.launch?.mode === 'exec'
        ? -session.pid
        : session.pid
    process.kill(targetPid, signal)
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
      `  ID: ${s.jobId ?? s.sessionId.slice(0, 8)}`,
      `  PID: ${s.pid}`,
      `  Kind: ${s.kind}`,
      `  Engine: ${engineType}`,
      `  Session: ${s.sessionId}`,
      `  CWD: ${s.cwd}`,
    ]

    if (s.name) parts.push(`  Name: ${s.name}`)
    if (s.routine) parts.push(`  Routine: ${s.routine}`)
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
  const storedJobs = await listStoredJobs()
  const candidates = [...sessions]
  for (const job of storedJobs) {
    if (!candidates.some(session => session.sessionId === job.sessionId))
      candidates.push(job)
  }

  if (!target) {
    if (candidates.length === 0) {
      console.log('No sessions with logs.')
      return
    }
    if (candidates.length === 1) {
      target = candidates[0]!.sessionId
    } else {
      console.log('Multiple sessions available. Specify one:')
      for (const s of candidates) {
        const label = s.name ? `${s.name} (${s.sessionId})` : s.sessionId
        console.log(`  ${label}  PID=${s.pid}`)
      }
      return
    }
  }

  const session = resolveSessionTarget(candidates, target)
  if (!session) {
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

  const session = resolveSessionTarget(sessions, target)
  if (!session) {
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

  const session = resolveSessionTarget(sessions, target)
  if (!session) {
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
  } else if (isManagedProcessRunning(session)) {
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
  const resolved = resolveJobTarget(sessions as BgJobRecord[], target)
  if (!('sessionId' in resolved)) {
    console.error(formatJobTargetError(resolved))
    process.exitCode = 1
    return
  }
  const session = resolved

  const result = signalSession(session, 'SIGTERM')
  if (!result.ok) {
    console.error(`Cannot stop session: ${result.reason ?? 'unknown error'}`)
    process.exitCode = 1
    return
  }

  const stored = (await listStoredJobs()).find(
    job => job.sessionId === session.sessionId,
  )
  if (stored) {
    await writeJobRecord({
      ...stored,
      status: 'stopped',
      waitingFor: undefined,
      updatedAt: Date.now(),
      error: undefined,
    })
  }
  console.log(`stopped ${session.jobId ?? session.sessionId.slice(0, 8)}`)
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
  if (target === '--help' || target === '-h') {
    console.log('Usage: claude respawn <id>|--all\n\n  Restart a background session with the current Claude binary.')
    return
  }
  if (target?.startsWith('-') && target !== '--all') {
    console.error(`unknown option '${target}'\nUsage: claude respawn <id>|--all`)
    process.exitCode = 1
    return
  }
  if (!target) {
    console.error('Usage: claude respawn <id|--all>')
    process.exitCode = 1
    return
  }

  const liveSessions = await listLiveSessions()
  const storedJobs = await listStoredJobs()
  const jobs: BgJobRecord[] =
    target === '--all'
      ? liveSessions.filter(s => s.kind === 'bg') as BgJobRecord[]
      : (() => {
          const all = [...storedJobs]
          for (const live of liveSessions) {
            if (!all.some(job => job.sessionId === live.sessionId))
              all.push(live as BgJobRecord)
          }
          const resolved = resolveJobTarget(all, target)
          if (!('sessionId' in resolved)) {
            console.error(formatJobTargetError(resolved))
            process.exitCode = 1
            return []
          }
          return [resolved]
        })()

  if (jobs.length === 0) {
    if (target === '--all') console.log('no live jobs to respawn')
    return
  }

  let failures = 0
  for (const job of jobs) {
    if (!job.args && job.launch?.mode !== 'exec') {
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
        isManagedProcessRunning(live)
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
        job.tmuxSessionName ?? `claude-bg-${(job.jobId ?? job.sessionId).slice(0, 8)}`
      const logPath =
        job.logPath ?? join(getSessionsDir(), 'logs', `${sessionName}.log`)
      const respawnArgs =
        job.launch?.mode === 'exec' ? [] : buildRespawnArgs(job)
      const respawnLaunch =
        job.launch?.mode === 'exec'
          ? job.launch
          : { mode: 'claude' as const, args: respawnArgs }
      const result = await engine.start({
        sessionName,
        args: respawnArgs,
        env: { ...process.env },
        logPath,
        cwd: job.cwd,
        launch: respawnLaunch,
        routine: job.routine,
        intent: job.intent,
        sessionId: job.sessionId,
      })
      await writeJobRecord({
        ...job,
        pid: result.pid,
        engine: result.engineUsed,
        tmuxSessionName:
          result.engineUsed === 'tmux' ? sessionName : job.tmuxSessionName,
        status: 'starting',
        updatedAt: Date.now(),
      })
      console.log(`respawned ${job.jobId ?? job.sessionId.slice(0, 8)} (${result.engineUsed})`)
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
  if (target === '--help' || target === '-h') {
    console.log('Usage: claude rm <id>\n\n  Delete a background job record. Logs are retained.')
    return
  }
  if (target?.startsWith('-')) {
    console.error(`unknown option '${target}'\nUsage: claude rm <id>`)
    process.exitCode = 1
    return
  }
  if (!target) {
    console.error('Usage: claude rm <id>')
    process.exitCode = 1
    return
  }

  const liveSessions = await listLiveSessions()
  const liveResolution = resolveJobTarget(liveSessions as BgJobRecord[], target)
  if ('sessionId' in liveResolution) {
    console.error('Session is still active; stop it before removing the job.')
    process.exitCode = 1
    return
  }
  if (liveResolution.kind === 'ambiguous') {
    console.error(formatJobTargetError(liveResolution))
    process.exitCode = 1
    return
  }

  const storedResolution = resolveJobTarget(await listStoredJobs(), target)
  if (!('sessionId' in storedResolution)) {
    console.error(formatJobTargetError(storedResolution))
    process.exitCode = 1
    return
  }
  const job = storedResolution

  try {
    await removeJobRecord(job)
    console.log(`removed ${job.jobId ?? job.sessionId.slice(0, 8)}`)
  } catch (error) {
    console.error(
      `Failed to remove ${job.sessionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exitCode = 1
  }
}

const MAX_BACKGROUND_STDIN_BYTES = 256 * 1024

async function readBackgroundStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  let data = ''
  let truncated = false
  const onData = (chunk: string | Buffer): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const remaining = MAX_BACKGROUND_STDIN_BYTES - data.length
    if (remaining <= 0) {
      truncated = true
      return
    }
    if (text.length > remaining) {
      data += text.slice(0, remaining)
      truncated = true
      return
    }
    data += text
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', onData)
  const timedOut = await peekForStdinData(process.stdin, 3_000)
  process.stdin.off('data', onData)
  if (timedOut && data.length === 0) return ''
  if (truncated)
    console.error(`Warning: piped background input exceeds ${MAX_BACKGROUND_STDIN_BYTES} bytes; truncated.`)
  return data.replace(/\r?\n$/, '')
}

function stripManagedSessionId(args: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg.startsWith('--session-id=')) continue
    if (arg === '--session-id') {
      if (args[index + 1] !== undefined) index++
      continue
    }
    result.push(arg)
  }
  return result
}

// Commander options that consume one or more argv values. These are used
// only when reconstructing a respawn command: bare positional text is the
// original prompt and must not be submitted a second time after --resume.
const CLAUDE_SINGLE_VALUE_FLAGS = new Set([
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--autocompact',
  '--fallback-model',
  '--from-pr',
  '--input-format',
  '--max-budget-usd',
  '--max-turns',
  '--model',
  '--name',
  '-n',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--prefill',
  '--remote-bin',
  '--resume',
  '--sdk-url',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--thinking',
  '--workload',
])

const CLAUDE_VARIADIC_VALUE_FLAGS = new Set([
  '--add-dir',
  '--betas',
  '--channels',
  '--dangerously-load-development-channels',
  '--file',
  '--mcp-config',
  '--plugin-dir',
])

const CLAUDE_OPTIONAL_VALUE_FLAGS = new Set([
  '--print',
  '-p',
  '--teleport',
  '--remote',
  '--remote-control',
  '--rc',
  '--worktree',
])

function isFlag(value: string): boolean {
  return value.length > 1 && value.startsWith('-')
}

/** Return the initial prompt represented by a Claude launch argv. */
function extractInitialPrompt(args: string[]): string | undefined {
  const terminator = args.indexOf('--')
  if (terminator >= 0) {
    const prompt = args.slice(terminator + 1).join(' ').trim()
    return prompt || undefined
  }

  let prompt: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (isFlag(arg)) {
      if (arg.startsWith('--print=') || arg.startsWith('-p=')) {
        const prompt = arg.slice(arg.indexOf('=') + 1).trim()
        if (prompt) return prompt
        continue
      }
      if (arg.includes('=')) continue
      if (CLAUDE_SINGLE_VALUE_FLAGS.has(arg)) {
        index++
        continue
      }
      if (CLAUDE_VARIADIC_VALUE_FLAGS.has(arg)) {
        while (index + 1 < args.length && !isFlag(args[index + 1]!)) index++
        continue
      }
      if (arg === '--print' || arg === '-p') {
        if (index + 1 < args.length && !isFlag(args[index + 1]!))
          prompt = args[++index]
        continue
      }
      if (CLAUDE_OPTIONAL_VALUE_FLAGS.has(arg)) {
        if (index + 1 < args.length && !isFlag(args[index + 1]!)) index++
        continue
      }
      continue
    }
    prompt = arg
  }
  return prompt?.trim() || undefined
}

/**
 * Build launch args for a respawn. Existing transcripts must be resumed,
 * not reopened with --session-id (which is rejected once the transcript
 * exists), and the original prompt must not be submitted again.
 */
function buildRespawnArgs(job: BgJobRecord): string[] {
  const source = job.args ?? []
  // A routine created without an initial prompt is intentionally an idle
  // session with no transcript to resume. Recreate its original launch and
  // keep the managed session ID in place for the fresh routine.
  if (job.routine && !job.intent) return stripManagedSessionId(source)
  const result: string[] = []
  for (let index = 0; index < source.length; index++) {
    const arg = source[index]!
    if (arg === '--') break
    if (arg === '--session-id' || arg === '--resume') {
      if (source[index + 1] !== undefined) index++
      continue
    }
    if (arg === '--continue' || arg === '--fork-session') continue
    if (arg.startsWith('--session-id=') || arg.startsWith('--resume=')) continue

    if (!isFlag(arg)) {
      // The launch's initial prompt is intentionally omitted. Any value that
      // belongs to a recognized flag was consumed in the flag branch below.
      continue
    }
    result.push(arg)
    if (arg.startsWith('--print=') || arg.startsWith('-p=')) {
      result[result.length - 1] = arg.slice(0, arg.indexOf('='))
      continue
    }
    if (arg.includes('=')) continue
    if (CLAUDE_SINGLE_VALUE_FLAGS.has(arg)) {
      if (source[index + 1] !== undefined) result.push(source[++index]!)
      continue
    }
    if (CLAUDE_VARIADIC_VALUE_FLAGS.has(arg)) {
      while (index + 1 < source.length && !isFlag(source[index + 1]!))
        result.push(source[++index]!)
      continue
    }
    if (CLAUDE_OPTIONAL_VALUE_FLAGS.has(arg)) {
      // --print/-p's optional value is an initial prompt. Other optional
      // values (e.g. --worktree name) are configuration and are retained.
      if ((arg === '--print' || arg === '-p') && source[index + 1] && !isFlag(source[index + 1]!)) {
        index++
      } else if (source[index + 1] && !isFlag(source[index + 1]!)) {
        result.push(source[++index]!)
      }
    }
  }
  return ['--resume', job.sessionId, ...result]
}

function appendPipedPrompt(args: string[], prompt: string): string[] {
  const terminator = args.indexOf('--')
  if (terminator >= 0) {
    const existing = args.slice(terminator + 1).join(' ')
    return [
      ...args.slice(0, terminator),
      '--',
      existing ? `${existing}\n${prompt}` : prompt,
    ]
  }
  return [...args, '--', prompt]
}

/**
 * `claude daemon bg [args]` — start a background session.
 *
 * Cross-platform: uses TmuxEngine on macOS/Linux when tmux is available,
 * falls back to DetachedEngine on Windows or when tmux is absent.
 */
export async function handleBgStart(args: string[]): Promise<void> {
  const engine = await selectEngine()

  const beforeTerminator = args.indexOf('--')
  const scan = beforeTerminator >= 0 ? args.slice(0, beforeTerminator) : args
  const execIndex = scan.findIndex(a => a === '--exec' || a.startsWith('--exec='))
  const execToken = execIndex >= 0 ? scan[execIndex]! : undefined
  const execUsesEquals = execToken?.startsWith('--exec=') ?? false
  const execCommand =
    execIndex < 0
      ? undefined
      : execUsesEquals
        ? execToken!.slice('--exec='.length)
        : args.slice(execIndex + 1).join(' ')

  if (execIndex >= 0 && !execCommand?.trim()) {
    console.error('--exec requires a command.')
    process.exitCode = 1
    return
  }

  // In `--exec <command>` form the command consumes every remaining argv
  // token, so flags after `--exec` are command text rather than Claude
  // metadata. In `--exec=<command>` form, trailing options remain available
  // for metadata parsing, matching the reference CLI's split behavior.
  const execMetadataArgs =
    execIndex < 0
      ? scan
      : execUsesEquals
        ? args.slice(0, execIndex).concat(args.slice(execIndex + 1))
        : args.slice(0, execIndex)
  const execMetadataTerminator = execMetadataArgs.indexOf('--')
  const execMetadataScan =
    execMetadataTerminator >= 0
      ? execMetadataArgs.slice(0, execMetadataTerminator)
      : execMetadataArgs

  const optionScan = execIndex >= 0 ? execMetadataScan : scan
  const routineIndex = optionScan.findIndex(a => a === '--routine' || a.startsWith('--routine='))
  let routine: string | undefined
  if (routineIndex >= 0 && execIndex < 0) {
    routine = optionScan[routineIndex]!.startsWith('--routine=')
      ? optionScan[routineIndex]!.slice('--routine='.length)
      : optionScan[routineIndex + 1]
    if (!routine || routine.startsWith('-')) {
      console.error('--routine requires a name.')
      process.exitCode = 1
      return
    }
  }

  const nameIndex = optionScan.findIndex(a => a === '--name' || a === '-n' || a.startsWith('--name='))
  const displayName =
    nameIndex < 0
      ? undefined
      : optionScan[nameIndex]!.startsWith('--name=')
        ? optionScan[nameIndex]!.slice('--name='.length)
        : optionScan[nameIndex + 1]

  // `--exec` consumes the remaining command text. Only the display name is
  // composable, matching the reference behavior; other Claude flags are not
  // silently forwarded to an unrelated shell command.
  if (execIndex >= 0) {
    const ignored = optionScan.filter(
      (arg, index) =>
        !(index === nameIndex || index === nameIndex + 1) &&
        arg.startsWith('-') &&
        arg !== '--exec' &&
        arg !== '--bg' &&
        arg !== '--background',
    )
    if (ignored.length > 0)
      console.error(`warning: --exec ignores ${ignored.join(' ')} (only --name composes)`)
  }

  const filteredArgs = (execIndex >= 0 ? [] : args).filter(
    a => a !== '--bg' && a !== '--background' && a !== '--pipe',
  )
  const pipedInput = execIndex >= 0 ? '' : await readBackgroundStdin()

  // Engines without interactive TTY input (e.g. detached) require -p/--print
  // or piped input. Tmux provides a virtual terminal so it works without -p.
  if (
    execIndex < 0 &&
    !routine &&
    !engine.supportsInteractiveInput &&
    !pipedInput &&
    !filteredArgs.some(a => a === '-p' || a === '--print')
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

  const sessionId = randomUUID()
  const jobId = sessionId.slice(0, 8)
  const collision = (await listStoredJobs()).find(
    job => job.jobId === jobId || job.sessionId.startsWith(jobId),
  )
  if (collision) {
    console.error(`Previous session ${jobId} is still shutting down — try again in a moment.`)
    process.exitCode = 1
    return
  }
  // Keep the transport/session name filesystem- and tmux-safe. The optional
  // user name is metadata only and must never become a shell/session target.
  const sessionName = `claude-bg-${jobId}`
  const logPath = join(
    getClaudeConfigHomeDir(),
    'sessions',
    'logs',
    `${sessionName}.log`,
  )

  try {
    const managedArgs =
      execIndex >= 0
        ? []
        : ['--session-id', sessionId, ...stripManagedSessionId(filteredArgs)]
    if (pipedInput) {
      const withInput = appendPipedPrompt(managedArgs, pipedInput)
      managedArgs.splice(0, managedArgs.length, ...withInput)
    }
    const launch: BgLaunch =
      execIndex >= 0
        ? { mode: 'exec', command: execCommand!.trim() }
        : { mode: 'claude', args: managedArgs }
    const launchIntent =
      execCommand?.trim() || pipedInput || extractInitialPrompt(filteredArgs)

    const result = await engine.start({
      sessionName,
      args: managedArgs,
      env: { ...process.env },
      logPath,
      cwd: process.cwd(),
      launch,
      routine,
      intent: launchIntent,
      sessionId,
    })

    await writeJobRecord({
      pid: result.pid,
      sessionId,
      jobId,
      cwd: process.cwd(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      kind: 'bg',
      name: displayName,
      logPath: result.logPath,
      engine: result.engineUsed,
      tmuxSessionName: result.engineUsed === 'tmux' ? sessionName : undefined,
      routine,
      intent: launchIntent,
      launch,
      args: managedArgs,
      status: routine && !execCommand && !pipedInput ? 'idle' : 'starting',
    })

    console.log(`Background session started: ${jobId}`)
    console.log(`  Engine: ${result.engineUsed}`)
    console.log(`  Log: ${result.logPath}`)
    console.log()
    console.log(
      `Use \`claude daemon attach ${jobId}\` to reconnect.`,
    )
    console.log(`Use \`claude daemon status\` to check status.`)
    console.log(`Use \`claude daemon kill ${jobId}\` to stop.`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}
