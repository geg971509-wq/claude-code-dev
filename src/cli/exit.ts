/**
 * CLI exit helpers for subcommand handlers.
 *
 * Consolidates the 4-5 line "print + lint-suppress + exit" block that was
 * copy-pasted ~60 times across `claude mcp *` / `claude plugin *` handlers.
 * The `: never` return type lets TypeScript narrow control flow at call sites
 * without a trailing `return`.
 */
import { writeToStdoutBeforeExit } from '../utils/process.js'

/* eslint-disable custom-rules/no-process-exit -- centralized CLI exit point */

// `return undefined as never` (not a post-exit throw) — tests spy on
// process.exit and let it return. Call sites write `return cliError(...)`
// where subsequent code would dereference narrowed-away values under mock.
// cliError uses console.error (tests spy on console.error); cliOk writes
// straight to fd 1, so a spy on process.stdout.write will NOT observe it.

/** Write an error message to stderr (if given) and exit with code 1. */
export function cliError(msg?: string): never {
  if (msg) console.error(msg)
  process.exit(1)
  return undefined as never
}

/**
 * Write a message to stdout (if given) and exit with code 0.
 *
 * Uses the blocking write because the process.exit() below discards anything
 * stdout still has buffered. Callers pass whole JSON dumps here
 * (`claude plugin list --json`), and past one pipe buffer — 64KB — that was
 * delivered as its first 65536 bytes and nothing more, with no error raised.
 */
export function cliOk(msg?: string): never {
  if (msg) writeToStdoutBeforeExit(msg + '\n')
  process.exit(0)
  return undefined as never
}
