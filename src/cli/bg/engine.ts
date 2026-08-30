/**
 * BgEngine — cross-platform background session engine abstraction.
 *
 * Implementations:
 *   TmuxEngine    — macOS/Linux with tmux installed
 *   DetachedEngine — Windows, or macOS/Linux without tmux (fallback)
 */

export interface SessionEntry {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: string
  name?: string
  logPath?: string
  entrypoint?: string
  status?: string
  waitingFor?: string
  updatedAt?: number
  bridgeSessionId?: string
  agent?: string
  /** Original CLI arguments, persisted for `respawn`. */
  args?: string[]
  tmuxSessionName?: string
  engine?: 'tmux' | 'detached' | 'pty'
  ptySocketPath?: string
  ptyTokenPath?: string
  /** Stable short identifier used by `attach`, `logs`, `stop`, `respawn`, and `rm`. */
  jobId?: string
  /** Reference-compatible launch metadata for respawn and recovery. */
  launch?:
    | { mode: 'claude'; args: string[] }
    | { mode: 'exec'; command: string }
  routine?: string
  intent?: string
  worktreePath?: string
  worktreeOwnershipToken?: string
  exitCode?: number | null
  error?: string
}

export interface BgStartOptions {
  sessionName: string
  args: string[]
  env: Record<string, string | undefined>
  logPath: string
  cwd: string
  launch?:
    | { mode: 'claude' }
    | { mode: 'exec'; command: string }
  routine?: string
  intent?: string
  sessionId?: string
}

export interface BgStartResult {
  pid: number
  sessionName: string
  logPath: string
  engineUsed: 'tmux' | 'detached' | 'pty'
}

export interface BgEngine {
  readonly name: 'tmux' | 'detached' | 'pty'
  /** Whether the engine provides a TTY for interactive REPL input. */
  readonly supportsInteractiveInput: boolean
  available(): Promise<boolean>
  start(opts: BgStartOptions): Promise<BgStartResult>
  attach(session: SessionEntry): Promise<void>
}
