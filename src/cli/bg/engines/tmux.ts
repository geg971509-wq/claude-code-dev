import { spawnSync } from 'child_process'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { buildCliLaunch, quoteCliLaunch } from '../../../utils/cliLaunch.js'
import { buildShellLaunch } from '../launch.js'
import type {
  BgEngine,
  BgStartOptions,
  BgStartResult,
  SessionEntry,
} from '../engine.js'

export class TmuxEngine implements BgEngine {
  readonly name = 'tmux' as const
  readonly supportsInteractiveInput = true

  async available(): Promise<boolean> {
    const { code } = await execFileNoThrow('tmux', ['-V'], { useCwd: false })
    return code === 0
  }

  async start(opts: BgStartOptions): Promise<BgStartResult> {
    const env: NodeJS.ProcessEnv = {
      ...opts.env,
      CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_CODE_SESSION_NAME: opts.sessionName,
      CLAUDE_CODE_SESSION_LOG: opts.logPath,
      CLAUDE_CODE_SESSION_ARGS: JSON.stringify(opts.args),
      CLAUDE_CODE_TMUX_SESSION: opts.sessionName,
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
        ? buildShellLaunch(
            `(${opts.launch.command}) >> '${opts.logPath.replace(/'/g, "'\\''")}' 2>&1`,
            env,
          )
        : buildCliLaunch(opts.args, { env })
    const result = spawnSync(
      'tmux',
      ['new-session', '-d', '-s', opts.sessionName, quoteCliLaunch(launch)],
      { stdio: 'inherit', env: launch.env, cwd: opts.cwd },
    )
    if (result.status !== 0) throw new Error('Failed to create tmux session.')
    return {
      pid: 0,
      sessionName: opts.sessionName,
      logPath: opts.logPath,
      engineUsed: 'tmux',
    }
  }

  async attach(session: SessionEntry): Promise<void> {
    if (!session.tmuxSessionName)
      throw new Error(`Session ${session.sessionId} has no tmux session name.`)
    const result = spawnSync(
      'tmux',
      ['attach-session', '-t', session.tmuxSessionName],
      {
        stdio: 'inherit',
      },
    )
    if (result.status !== 0)
      throw new Error(
        `Failed to attach to tmux session '${session.tmuxSessionName}'.`,
      )
  }
}
