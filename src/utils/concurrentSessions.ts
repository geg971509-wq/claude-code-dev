import { feature } from 'bun:bundle'
import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getPlatform } from './platform.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { atomicWriteFile } from './sessionStoragePortable.js'
import { getAgentId } from './teammate.js'
import { getUdsMessagingSocketPath } from './udsMessaging.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

function getSessionLaunchArgs(): string[] | undefined {
  if (!feature('BG_SESSIONS')) return undefined
  const raw = process.env.CLAUDE_CODE_SESSION_ARGS
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every(a => typeof a === 'string')
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function getSessionLaunchMode(): 'claude' | 'exec' {
  return process.env.CLAUDE_CODE_SESSION_LAUNCH_MODE === 'exec'
    ? 'exec'
    : 'claude'
}

/**
 * Kind override from env. Set by the spawner (`claude --bg`, daemon
 * supervisor) so the child can register without the parent having to
 * write the file for it — cleanup-on-exit wiring then works for free.
 * Gated so the env-var string is DCE'd from external builds.
 */
function envSessionKind(): SessionKind | undefined {
  if (feature('BG_SESSIONS')) {
    const k = process.env.CLAUDE_CODE_SESSION_KIND
    if (k === 'bg' || k === 'daemon' || k === 'daemon-worker') return k
  }
  return undefined
}

/**
 * True when this REPL is running inside a `claude --bg` tmux session.
 * Exit paths (/exit, ctrl+c, ctrl+d) should detach the attached client
 * instead of killing the process.
 */
export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

/**
 * Write a PID file for this session and register cleanup.
 *
 * Registers all top-level sessions — interactive CLI, SDK (vscode, desktop,
 * typescript, python, -p), bg/daemon spawns — so `claude ps` sees everything
 * the user might be running. Skips only teammates/subagents, which would
 * conflate swarm usage with genuine concurrency and pollute ps with noise.
 *
 * Returns true if registered, false if skipped.
 * Errors logged to debug, never thrown.
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false

  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  registerCleanup(async () => {
    try {
      await unlink(pidFile)
    } catch {
      // ENOENT is fine (already deleted or never written)
    }
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const launchArgs = getSessionLaunchArgs()
    const launchMode = getSessionLaunchMode()
    const existingJob =
      feature('BG_SESSIONS') && kind === 'bg'
        ? await readFile(join(dir, 'jobs', `${getSessionId()}.json`), 'utf8')
            .then(raw => jsonParse(raw) as Record<string, unknown>)
            .catch(() => undefined)
        : undefined
    const metadata = {
      // The parent writes the durable job record before the child has
      // necessarily registered its PID. Merge that record when available so
      // child registration cannot erase user-facing metadata (notably
      // --name), stable job IDs, worktree ownership, or launch intent.
      ...(existingJob ?? {}),
      pid: process.pid,
      sessionId: getSessionId(),
      cwd: getOriginalCwd(),
      startedAt:
        typeof existingJob?.startedAt === 'number'
          ? existingJob.startedAt
          : Date.now(),
      kind,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      ...(feature('CROSS_SESSION_MESSAGING')
        ? { messagingSocketPath: getUdsMessagingSocketPath() }
        : {}),
      ...(feature('BG_SESSIONS')
        ? {
            // `CLAUDE_CODE_SESSION_NAME` is the transport name used by tmux
            // and logs, not necessarily the user's display name. A managed
            // `claude --bg` parent supplies the display name in its durable
            // job record; do not replace an absent name with the transport
            // slug if the child happens to register before that record is
            // written. Standalone Fleet/agent launches have no stable
            // session ID and retain the historical transport-name fallback.
            ...(typeof existingJob?.name === 'string'
              ? { name: existingJob.name }
              : process.env.CLAUDE_CODE_SESSION_ID
                ? {}
                : { name: process.env.CLAUDE_CODE_SESSION_NAME }),
            logPath: process.env.CLAUDE_CODE_SESSION_LOG,
            agent: process.env.CLAUDE_CODE_AGENT,
            args: launchArgs,
            engine: process.env.CLAUDE_CODE_SESSION_ENGINE,
            tmuxSessionName: process.env.CLAUDE_CODE_TMUX_SESSION,
            ptySocketPath: process.env.CLAUDE_CODE_PTY_SOCKET,
            ptyTokenPath: process.env.CLAUDE_CODE_PTY_TOKEN,
            jobId:
              typeof existingJob?.jobId === 'string'
                ? existingJob.jobId
                : getSessionId().slice(0, 8),
            schemaVersion: 1,
            launch:
              launchMode === 'exec'
                ? {
                    mode: 'exec',
                    command: process.env.CLAUDE_CODE_SESSION_EXEC,
                  }
                : { mode: 'claude', args: launchArgs },
            routine: process.env.CLAUDE_CODE_SESSION_ROUTINE,
            intent: process.env.CLAUDE_CODE_SESSION_INTENT,
            // A routine with no prompt intentionally remains idle; all other
            // registered background sessions are now running.
            status:
              existingJob?.status === 'idle'
                ? 'idle'
                : kind === 'bg'
                  ? 'running'
                  : existingJob?.status,
            updatedAt: Date.now(),
          }
        : {}),
    }
    await writeFile(pidFile, jsonStringify(metadata))
    if (feature('BG_SESSIONS') && launchArgs) {
      try {
        const jobsDir = join(dir, 'jobs')
        await mkdir(jobsDir, { recursive: true, mode: 0o700 })
        await chmod(jobsDir, 0o700)
        await atomicWriteFile(
          join(jobsDir, `${metadata.sessionId}.json`),
          jsonStringify(metadata),
          { mode: 0o600 },
        )
      } catch (e) {
        // Job persistence is an enhancement; a failure must not make an
        // otherwise successful PID registration look like a failed session.
        logForDebugging(
          `[concurrentSessions] job persistence failed: ${errorMessage(e)}`,
        )
      }
    }
    // --resume / /resume mutates getSessionId() via switchSession. Without
    // this, the PID file's sessionId goes stale and `claude ps` sparkline
    // reads the wrong transcript.
    onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    return true
  } catch (e) {
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(e)}`)
    return false
  }
}

/**
 * Update this session's name in its PID registry file so ListPeers
 * can surface it. Best-effort: silently no-op if name is falsy, the
 * file doesn't exist (session not registered), or read/write fails.
 */
async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<
      string,
      unknown
    >
    const updated = { ...data, ...patch }
    await writeFile(pidFile, jsonStringify(updated))

    // Keep the durable job envelope in lockstep with the PID registry. This
    // matters for user renames and /resume: the durable file is what `ps`,
    // `stop`, `respawn`, and `rm` use when the child is between registrations
    // or has already exited. A session switch moves the record to the new
    // filename while preserving its stable jobId.
    if (feature('BG_SESSIONS') && typeof data.sessionId === 'string') {
      const oldSessionId = data.sessionId
      const newSessionId =
        typeof updated.sessionId === 'string' ? updated.sessionId : oldSessionId
      const oldJobPath = join(getSessionsDir(), 'jobs', `${oldSessionId}.json`)
      const job = await readFile(oldJobPath, 'utf8')
        .then(raw => jsonParse(raw) as Record<string, unknown>)
        .catch(() => undefined)
      if (job) {
        const nextJob = {
          ...job,
          ...patch,
          pid: process.pid,
          sessionId: newSessionId,
          updatedAt: Date.now(),
        }
        const newJobPath = join(
          getSessionsDir(),
          'jobs',
          `${newSessionId}.json`,
        )
        await atomicWriteFile(newJobPath, jsonStringify(nextJob), {
          mode: 0o600,
        })
        if (newJobPath !== oldJobPath) {
          await unlink(oldJobPath).catch(() => {})
        }
      }
    }
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] updatePidFile failed: ${errorMessage(e)}`,
    )
  }
}

export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

/**
 * Record this session's Remote Control session ID so peer enumeration can
 * dedup: a session reachable over both UDS and bridge should only appear
 * once (local wins). Cleared on bridge teardown so stale IDs don't
 * suppress a legitimately-remote session after reconnect.
 */
export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

/**
 * Push live activity state for `claude ps`. Fire-and-forget from REPL's
 * status-change effect — a dropped write just means ps falls back to
 * transcript-tail derivation for one refresh.
 */
export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  if (!feature('BG_SESSIONS')) return
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}

/**
 * Count live concurrent CLI sessions (including this one).
 * Filters out stale PID files (crashed sessions) and deletes them.
 * Returns 0 on any error (conservative).
 */
export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return 0
  }

  let count = 0
  for (const file of files) {
    // Strict filename guard: only `<pid>.json` is a candidate. parseInt's
    // lenient prefix-parsing means `2026-03-14_notes.md` would otherwise
    // parse as PID 2026 and get swept as stale — silent user data loss.
    // See anthropics/claude-code#34210.
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // Stale file from a crashed session — sweep it. Skip on WSL: if
      // ~/.claude/sessions/ is shared with Windows-native Claude (symlink
      // or CLAUDE_CONFIG_DIR), a Windows PID won't be probeable from WSL
      // and we'd falsely delete a live session's file. This is just
      // telemetry so conservative undercount is acceptable.
      void unlink(join(dir, file)).catch(() => {})
    }
  }
  return count
}
