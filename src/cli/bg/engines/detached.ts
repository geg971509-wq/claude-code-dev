import { closeSync, mkdirSync, openSync } from 'fs'
import { dirname } from 'path'
import { buildCliLaunch, spawnCli } from '../../../utils/cliLaunch.js'
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

    const launch = buildCliLaunch(opts.args, {
      env: {
        ...opts.env,
        CLAUDE_CODE_SESSION_KIND: 'bg',
        CLAUDE_CODE_SESSION_NAME: opts.sessionName,
        CLAUDE_CODE_SESSION_LOG: opts.logPath,
      } as NodeJS.ProcessEnv,
    })

    const child = spawnCli(launch, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: opts.cwd,
    })

    // Capture spawn errors before unref so start() can reject instead of crashing
    return new Promise<BgStartResult>((resolve, reject) => {
      let settled = false

      child.on('error', err => {
        if (settled) return
        settled = true
        closeSync(logFd)
        reject(new Error(`Failed to spawn background session: ${err.message}`))
      })

      // Wait for spawn event to ensure spawn errors are catchable
      child.on('spawn', () => {
        if (settled) return
        settled = true
        closeSync(logFd)

        const pid = child.pid ?? 0

        resolve({
          pid,
          sessionName: opts.sessionName,
          logPath: opts.logPath,
          engineUsed: 'detached',
        })
      })

      child.unref()
    })
  }

  async attach(session: SessionEntry): Promise<void> {
    if (!session.logPath) {
      throw new Error(`Session ${session.sessionId} has no log path.`)
    }
    await tailLog(session.logPath)
  }
}
