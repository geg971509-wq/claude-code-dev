#!/usr/bin/env bun
/**
 * Smoke-test the built production CLI entry points.
 *
 * This intentionally exercises dist/ rather than source modules so packaging
 * regressions (missing entry points, runtime-only imports, bootstrap crashes)
 * are caught before publish.
 *
 * Usage:
 *   bun run scripts/production-test.ts
 *   bun run scripts/production-test.ts --offline
 *   bun run scripts/production-test.ts --verbose
 *   bun run scripts/production-test.ts --bun
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')
const PROCESS_TIMEOUT_MS = 20_000

type Options = {
  offline: boolean
  verbose: boolean
  bunOnly: boolean
}

type ProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

type Runtime = {
  name: string
  command: string[]
}

function parseArgs(args: string[]): Options {
  const options: Options = { offline: false, verbose: false, bunOnly: false }
  for (const arg of args) {
    if (arg === '--offline') options.offline = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--bun') options.bunOnly = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function cleanEnvironment(
  root: string,
  offline: boolean,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : [],
    ),
  )

  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_AUTH_TOKEN',
    'GROK_API_KEY',
    'XAI_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AZURE_API_KEY',
  ]) {
    delete env[key]
  }

  Object.assign(env, {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CI: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    OTEL_SDK_DISABLED: 'true',
  })

  if (offline) {
    const deadProxy = 'http://127.0.0.1:9'
    Object.assign(env, {
      HTTP_PROXY: deadProxy,
      HTTPS_PROXY: deadProxy,
      ALL_PROXY: deadProxy,
      NO_PROXY: '127.0.0.1,localhost',
    })
  }

  return env
}

async function runProcess(
  command: string[],
  args: string[],
  env: Record<string, string>,
): Promise<ProcessResult> {
  const proc = Bun.spawn({
    cmd: [...command, ...args],
    cwd: ROOT,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, PROCESS_TIMEOUT_MS)

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

function summarize(result: ProcessResult): string {
  const output = `${result.stdout}\n${result.stderr}`.trim()
  return output.length <= 1_000 ? output : `${output.slice(0, 997)}...`
}

async function smokeRuntime(
  runtime: Runtime,
  env: Record<string, string>,
  verbose: boolean,
): Promise<void> {
  for (const args of [['--version'], ['--help']] as const) {
    const label = `${runtime.name} ${args.join(' ')}`
    const result = await runProcess(runtime.command, [...args], env)

    if (verbose) {
      console.log(`\n--- ${label} stdout ---\n${result.stdout.trimEnd()}`)
      if (result.stderr.trim()) {
        console.log(`\n--- ${label} stderr ---\n${result.stderr.trimEnd()}`)
      }
    }

    if (result.timedOut) throw new Error(`${label} timed out`)
    if (result.exitCode !== 0) {
      throw new Error(
        `${label} exited ${result.exitCode}: ${summarize(result)}`,
      )
    }
    if (`${result.stdout}${result.stderr}`.trim().length === 0) {
      throw new Error(`${label} produced no output`)
    }
    console.log(`✓ ${label}`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const nodeEntry = join(DIST, 'cli-node.js')
  const bunEntry = join(DIST, 'cli-bun.js')

  const required = options.bunOnly ? [bunEntry] : [nodeEntry, bunEntry]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(
      `production build is missing: ${missing.join(', ')}; run "bun run build:vite" first`,
    )
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'ccb-production-smoke-'))
  for (const dir of ['home', 'xdg', 'claude']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }

  try {
    const env = cleanEnvironment(tempRoot, options.offline)
    const runtimes: Runtime[] = options.bunOnly
      ? [{ name: 'bun', command: ['bun', bunEntry] }]
      : [
          { name: 'node', command: ['node', nodeEntry] },
          { name: 'bun', command: ['bun', bunEntry] },
        ]

    for (const runtime of runtimes) {
      await smokeRuntime(runtime, env, options.verbose)
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  console.log('Production runtime smoke test passed.')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
