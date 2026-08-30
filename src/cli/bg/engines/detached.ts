import { closeSync, mkdirSync, openSync } from 'fs'
import { dirname } from 'path'
import { buildCliLaunch, spawnCli } from '../../../utils/cliLaunch.js'
import { buildShellLaunch } from '../launch.js'
import type {
  BgEngine,
  BgStartOptions,
  BgStartResult,
  SessionEntry,
} from '../engine.js'
import { tailLog } from '../tail.js'

export class DetachedEngine implements BgEngine {
  readonly name = 'detached' as const
  readonly supportsInteractiveInput = false

  async available(): Promise<boolean> {
    return true
  }

  async start(opts: BgStartOptions): Promise<BgStartResult> {
    mkdirSync(dirname(opts.logPath), { recursive: true })
    const logFd = openSync(opts.logPath, 'a')
    const env: NodeJS.ProcessEnv = {
      ...opts.env,
      CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_CODE_SESSION_NAME: opts.sessionName,
      CLAUDE_CODE_SESSION_LOG: opts.logPath,
      CLAUDE_CODE_SESSION_ARGS: JSON.stringify(opts.args),
      ...(opts.sessionId ? { CLAUDE_CODE_SESSION_ID: opts.sessionId } : {}),
      ...(opts.routine ? { CLAUDE_CODE_SESSION_ROUTINE: opts.routine } : {}),
      ...(opts.intent ? { CLAUDE_CODE_SESSION_INTENT: opts.intent } : {}),
      CLAUDE_CODE_SESSION_LAUNCH_MODE: opts.launch?.mode ?? 'claude',
      ...(opts.launch?.mode === 'exec'
        ? { CLAUDE_CODE_SESSION_EXEC: opts.launch.command }
        : {}),
    }
    const launch =
      opts.launch?.mode === 'exec'
        ? buildShellLaunch(opts.launch.command, env)
        : buildCliLaunch(opts.args, { env })
    const child = spawnCli(launch, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: opts.cwd,
    })

    return new Promise<BgStartResult>((resolve, reject) => {
      let settled = false
      child.on('error', err => {
        if (settled) return
        settled = true
        closeSync(logFd)
        reject(new Error(`Failed to spawn background session: ${err.message}`))
      })
      child.on('spawn', () => {
        if (settled) return
        settled = true
        closeSync(logFd)
        resolve({
          pid: child.pid ?? 0,
          sessionName: opts.sessionName,
          logPath: opts.logPath,
          engineUsed: 'detached',
        })
      })
      child.unref()
    })
  }

  async attach(session: SessionEntry): Promise<void> {
    if (!session.logPath)
      throw new Error(`Session ${session.sessionId} has no log path.`)
    await tailLog(session.logPath)
  }
}
