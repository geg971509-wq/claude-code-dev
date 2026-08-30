import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCliLaunch } from '../../../utils/cliLaunch.js'
import { buildShellLaunch } from '../launch.js'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { atomicWriteFile } from '../../../utils/sessionStoragePortable.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import type {
  BgEngine,
  BgStartOptions,
  BgStartResult,
  SessionEntry,
} from '../engine.js'
import { attachPtySession } from '../ptyClient.js'
import type { PtyHostConfig } from '../ptyHost.js'

async function waitForReady(path: string): Promise<number> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const file = Bun.file(path)
    if (await file.exists()) {
      const value: unknown = JSON.parse(await file.text())
      if (
        typeof value === 'object' &&
        value !== null &&
        'pid' in value &&
        typeof value.pid === 'number' &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 1
      )
        return value.pid
    }
    await Bun.sleep(25)
  }
  throw new Error('Timed out starting the macOS PTY host.')
}

export class PtyEngine implements BgEngine {
  readonly name = 'pty' as const
  readonly supportsInteractiveInput = true

  async available(): Promise<boolean> {
    return process.platform === 'darwin' && typeof Bun.Terminal === 'function'
  }

  async start(opts: BgStartOptions): Promise<BgStartResult> {
    const hostDir = join(
      getClaudeConfigHomeDir(),
      'sessions',
      'pty',
      opts.sessionName,
    )
    const socketPath = join(hostDir, 'host.sock')
    const tokenPath = join(hostDir, 'host.token')
    const readyPath = join(hostDir, 'host.ready.json')
    const ackPath = join(hostDir, 'host.ready.ack')
    const configPath = join(hostDir, 'host.config.json')
    await mkdir(hostDir, { recursive: true, mode: 0o700 })
    // A crashed PTY host can leave handshake markers behind. Remove them
    // before spawning a new host so waitForReady cannot accept an old PID
    // and the new host cannot mistake a stale ack for its own startup.
    await Promise.all([
      rm(readyPath, { force: true }),
      rm(ackPath, { force: true }),
    ])

    const env: NodeJS.ProcessEnv = {
      ...opts.env,
      CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_CODE_SESSION_NAME: opts.sessionName,
      CLAUDE_CODE_SESSION_LOG: opts.logPath,
      CLAUDE_CODE_SESSION_ARGS: JSON.stringify(opts.args),
      CLAUDE_CODE_SESSION_ENGINE: 'pty',
      CLAUDE_CODE_PTY_SOCKET: socketPath,
      CLAUDE_CODE_PTY_TOKEN: tokenPath,
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
    const config: PtyHostConfig = {
      version: 1,
      readyPath,
      ackPath,
      options: {
        socketPath,
        tokenPath,
        command: launch.execPath,
        args: launch.args,
        cwd: opts.cwd,
        env: launch.env,
        logPath: opts.logPath,
      },
    }
    await atomicWriteFile(configPath, jsonStringify(config), { mode: 0o600 })
    const hostLaunch = buildCliLaunch(['--bg-pty-host', configPath])
    const host = spawn(hostLaunch.execPath, hostLaunch.args, {
      detached: true,
      env: hostLaunch.env,
      stdio: 'ignore',
    })
    host.unref()
    try {
      const pid = await waitForReady(readyPath)
      await atomicWriteFile(ackPath, '', { mode: 0o600 })
      await rm(readyPath, { force: true })
      return {
        pid,
        sessionName: opts.sessionName,
        logPath: opts.logPath,
        engineUsed: 'pty',
      }
    } catch (error) {
      host.kill('SIGTERM')
      await rm(hostDir, { recursive: true, force: true })
      throw error
    }
  }

  async attach(session: SessionEntry): Promise<void> {
    await attachPtySession(session)
  }
}
