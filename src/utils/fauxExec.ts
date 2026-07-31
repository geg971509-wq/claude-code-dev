/**
 * Scripted subprocess results, for offline/deterministic tests.
 *
 * Same shape of seam as the faux provider (src/services/api/faux/): one env
 * check at the single chokepoint every caller already funnels through —
 * execFileNoThrowWithCwd — so 263 call sites across 65 files become testable
 * without mocking execa (which no test currently does).
 *
 * NOT a sandbox. 16 modules import execa directly and bypass this entirely
 * (notably auth.ts and secureStorage/macOsKeychainStorage.ts). The goal is
 * testability of the wrapper's callers, not hermetic subprocess isolation.
 *
 * Script format — JSON, either a bare array or { commands: [...] }:
 *
 *   [
 *     { "file": "git", "args": ["rev-parse", "HEAD"], "stdout": "abc123\n" },
 *     { "file": "git", "args": ["status"], "code": 1, "stderr": "not a repo" },
 *     { "file": "gh", "stdout": "gh version 2.0.0" }
 *   ]
 *
 * Matching: first entry whose `file` matches and whose `args` deep-equal the
 * call's args wins. An entry with no `args` matches any args for that file.
 * `"once": true` consumes the entry, so successive identical calls can return
 * different results.
 *
 * Unmatched commands do NOT fall through to a real subprocess — they resolve
 * with code 1 and an explanatory `error`. Falling through would make a typo in
 * a script silently hit the real git/gh/network, which is the exact class of
 * bug this seam exists to remove.
 */
import { readFileSync } from 'node:fs'

export type FauxExecEntry = {
  file: string
  /** Exact match against the call's args. Omit to match any args. */
  args?: string[]
  stdout?: string
  stderr?: string
  /** Exit code. Defaults to 0. */
  code?: number
  /** Consume this entry after one match, so the next call falls to a later one. */
  once?: boolean
}

export type FauxExecResult = {
  stdout: string
  stderr: string
  code: number
  error?: string
}

export type FauxExecScript = { commands: FauxExecEntry[] }

export function parseFauxExecScript(raw: string): FauxExecScript {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(
      `faux exec script is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const commands = Array.isArray(parsed)
    ? parsed
    : (parsed as { commands?: unknown })?.commands
  if (!Array.isArray(commands)) {
    throw new Error('faux exec script: expected an array of commands')
  }
  commands.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`faux exec script: command ${i} must be an object`)
    }
    const e = entry as Record<string, unknown>
    if (typeof e.file !== 'string' || e.file === '') {
      throw new Error(
        `faux exec script: command ${i}: "file" must be a non-empty string`,
      )
    }
    if (e.args !== undefined) {
      if (!Array.isArray(e.args) || e.args.some(a => typeof a !== 'string')) {
        throw new Error(
          `faux exec script: command ${i}: "args" must be an array of strings`,
        )
      }
    }
    for (const key of ['stdout', 'stderr'] as const) {
      if (e[key] !== undefined && typeof e[key] !== 'string') {
        throw new Error(
          `faux exec script: command ${i}: "${key}" must be a string`,
        )
      }
    }
    if (e.code !== undefined && typeof e.code !== 'number') {
      throw new Error(`faux exec script: command ${i}: "code" must be a number`)
    }
  })
  return { commands: commands as FauxExecEntry[] }
}

// Cached per script path so each call does not re-read and re-parse the file.
// `once` consumption mutates this array, which is why the cache is keyed by
// path and not by content.
const scriptCache = new Map<string, FauxExecScript | Error>()

/** Clear the parsed-script cache. Exported for tests that swap scripts. */
export function resetFauxExecScriptCache(): void {
  scriptCache.clear()
}

function loadScript(path: string): FauxExecScript | Error {
  const cached = scriptCache.get(path)
  if (cached) {
    return cached
  }
  let value: FauxExecScript | Error
  try {
    value = parseFauxExecScript(readFileSync(path, 'utf8'))
  } catch (e) {
    value = e instanceof Error ? e : new Error(String(e))
  }
  scriptCache.set(path, value)
  return value
}

function argsMatch(entry: FauxExecEntry, args: string[]): boolean {
  if (entry.args === undefined) {
    return true
  }
  return (
    entry.args.length === args.length &&
    entry.args.every((a, i) => a === args[i])
  )
}

/**
 * Resolve a scripted result for one subprocess call.
 *
 * Never throws: a missing or malformed script is reported as a failed result,
 * because the caller (execFileNoThrowWithCwd) is contractually non-throwing.
 */
export function resolveFauxExec(
  scriptPath: string,
  file: string,
  args: string[],
): FauxExecResult {
  const script = loadScript(scriptPath)
  if (script instanceof Error) {
    return {
      stdout: '',
      stderr: '',
      code: 1,
      error: `[faux exec] ${script.message}`,
    }
  }
  const index = script.commands.findIndex(
    entry => entry.file === file && argsMatch(entry, args),
  )
  if (index === -1) {
    const printable = [file, ...args].join(' ')
    return {
      stdout: '',
      stderr: '',
      code: 1,
      error: `[faux exec] no scripted result for: ${printable}`,
    }
  }
  const entry = script.commands[index]!
  if (entry.once) {
    script.commands.splice(index, 1)
  }
  return {
    stdout: entry.stdout ?? '',
    stderr: entry.stderr ?? '',
    code: entry.code ?? 0,
    ...(entry.code !== undefined && entry.code !== 0
      ? { error: `Command failed with exit code ${entry.code}` }
      : {}),
  }
}
