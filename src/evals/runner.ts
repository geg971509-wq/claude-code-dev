/**
 * Evals harness — runs the full Claude Code CLI with a scripted (faux) model.
 *
 * Usage:
 *
 *   const result = await runEval({
 *     prompt: 'Say hello',
 *     fauxScript: [{ text: 'Hello from faux!' }],
 *   })
 *   expect(result.output).toContain('Hello from faux!')
 *   cleanupEval(result)
 *
 * The faux provider (CLAUDE_CODE_USE_FAUX=1) replaces the LLM with a JSON
 * script of pre-recorded turns, so evals are offline, deterministic, and free.
 * Tool calls in the faux script execute for real — but only within the project
 * root (the subprocess's cwd). The CLI's default permission model denies
 * operations on paths outside that root, including temp dirs. For evals that
 * assert on filesystem side-effects of tool calls, place fixture files inside
 * PROJECT_ROOT and reference them by absolute path in the faux script.
 *
 * Implementation note: the subprocess runs `bun src/entrypoints/cli.tsx` from
 * the project root so that `src/*` path aliases resolve without a built bundle.
 * The `dir` temp path is available for setup() fixtures and result inspection,
 * but is not accessible to CLI tool calls.
 *
 * @see src/services/api/faux/index.ts for the FauxTurn schema
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FauxTurn } from '../services/api/faux/index.js'

export type { FauxTurn }

// Re-exported so callers can construct FauxScript values without an extra import.
export type FauxScript = { turns: FauxTurn[] }

const CLI_ENTRYPOINT = resolve(import.meta.dir, '../entrypoints/cli.tsx')
const PROJECT_ROOT = resolve(import.meta.dir, '../..')

export type EvalOptions = {
  /**
   * The user message. Sent as a single -p prompt to the CLI (pipe mode).
   * Multi-turn conversations are driven entirely by fauxScript — the second
   * turn onwards comes from the scripted model response triggering tool calls
   * whose results loop back into the next scripted turn.
   */
  prompt: string
  /**
   * Scripted model responses. Use a function form when turns reference fixture
   * paths that are only known after setup() creates the temp dir.
   *
   * @example static
   *   fauxScript: [{ text: 'Done.' }]
   *
   * @example with dir reference
   *   fauxScript: (dir) => [
   *     { toolUses: [{ name: 'Read', input: { file_path: join(dir, 'input.txt') } }] },
   *     { text: 'I read it.' },
   *   ]
   */
  fauxScript: FauxTurn[] | ((dir: string) => FauxTurn[])
  /**
   * Called with the temp working dir before the CLI starts.
   * Create fixture files here that the agent will interact with.
   */
  setup?: (dir: string) => void | Promise<void>
  /**
   * Extra environment variables merged over the subprocess env.
   * CLAUDE_CODE_USE_FAUX, CLAUDE_CODE_FAUX_SCRIPT, and CLAUDE_CONFIG_DIR are
   * always set by the harness and cannot be overridden here.
   */
  env?: Record<string, string>
  /** Subprocess kill timeout in ms (default: 30 000). */
  timeout?: number
}

export type EvalResult = {
  /** Combined stdout from the CLI. The final agent text output lands here. */
  output: string
  /** Combined stderr from the CLI — useful for debugging failures. */
  stderr: string
  exitCode: number
  /** True when the harness terminated the subprocess after its deadline. */
  timedOut: boolean
  /**
   * Temp directory created for this eval. The faux script and fixture files
   * live here. NOT cleaned up automatically — call cleanupEval(result) when
   * done, or use runEvalAndClean() for text-output-only assertions.
   */
  dir: string
}

/**
 * Run the full Claude Code CLI in pipe mode with a scripted faux model.
 *
 * Returns stdout/stderr/exitCode and the temp dir for filesystem assertions.
 * The caller is responsible for cleanup — call cleanupEval(result) after
 * all filesystem assertions are done.
 */
export async function runEval(options: EvalOptions): Promise<EvalResult> {
  const { prompt, fauxScript, setup, env = {}, timeout = 30_000 } = options

  const dir = mkdtempSync(join(tmpdir(), 'claude-eval-'))
  const configDir = mkdtempSync(join(tmpdir(), 'claude-eval-cfg-'))
  let succeeded = false
  let timedOut = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined

  try {
    if (setup) await setup(dir)

    const turns =
      typeof fauxScript === 'function' ? fauxScript(dir) : fauxScript
    const scriptPath = join(dir, '.eval-faux.json')
    writeFileSync(scriptPath, JSON.stringify({ turns }))

    // Whitelist the environment variables the subprocess needs, rather than
    // passing the full process.env. This prevents real API credentials
    // (ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_*, etc.) from leaking into the
    // eval subprocess — which would allow a sideQuery or an ungated provider
    // path to make real network calls and incur real costs.
    const safeEnvKeys = [
      'PATH',
      'HOME',
      'TMPDIR',
      'TEMP',
      'TMP',
      'SHELL',
      'USER',
      'LOGNAME',
      'TERM',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'BUN_INSTALL',
      'NODE_PATH',
      'XDG_RUNTIME_DIR',
    ]
    const baseEnv: Record<string, string> = {}
    for (const key of safeEnvKeys) {
      const val = process.env[key]
      if (val !== undefined) baseEnv[key] = val
    }

    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRYPOINT, '-p', prompt],
      cwd: PROJECT_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...baseEnv,
        ...env,
        // These are set last so callers cannot accidentally override them.
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_USE_FAUX: '1',
        CLAUDE_CODE_FAUX_SCRIPT: scriptPath,
        NO_COLOR: '1',
        CI: 'true',
      },
    })

    killTimer = setTimeout(() => {
      if (proc.exitCode !== null) return
      timedOut = true
      proc.kill()
      forceKillTimer = setTimeout(() => {
        if (proc.exitCode !== null) return
        if (process.platform === 'win32') proc.kill()
        else proc.kill('SIGKILL')
      }, 1000)
      forceKillTimer.unref?.()
    }, timeout)
    killTimer.unref?.()
    const [output, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    succeeded = true
    return { output, stderr, exitCode, timedOut, dir }
  } finally {
    clearTimeout(killTimer)
    clearTimeout(forceKillTimer)
    rmSync(configDir, { recursive: true, force: true })
    // If setup() or script serialisation threw, clean dir too — caller never
    // sees the EvalResult so has no way to call cleanupEval().
    if (!succeeded) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Like runEval but removes the working directory before returning.
 * Use when you only need to assert on text output, not filesystem state.
 */
export async function runEvalAndClean(
  options: EvalOptions,
): Promise<Omit<EvalResult, 'dir'>> {
  const { dir, ...rest } = await runEval(options)
  rmSync(dir, { recursive: true, force: true })
  return rest
}

/** Remove the working directory left by runEval. */
export function cleanupEval(result: EvalResult): void {
  if (existsSync(result.dir)) {
    rmSync(result.dir, { recursive: true, force: true })
  }
}
