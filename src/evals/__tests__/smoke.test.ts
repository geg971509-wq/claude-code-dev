/**
 * Smoke tests for the evals harness.
 *
 * These run the full CLI as a subprocess against a faux (scripted) model. They
 * verify the harness wiring end-to-end — not that the agent solves hard tasks.
 * Put domain-specific evals in separate files.
 *
 * No build step: the harness runs `src/entrypoints/cli.tsx` directly, so these
 * always exercise current source.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupEval,
  runEval,
  runEvalAndClean,
  type EvalResult,
} from '../runner.js'

/**
 * Assert a clean run, attaching both streams to the failure message.
 *
 * Worth the wrapper because the harness's two known break modes are both hard
 * to read from a bare `exitCode: 1`:
 *
 * - "fixture missing" on stdout means VCR intercepted the call. VCR wraps
 *   queryModel, so it demands a recorded fixture before the faux dispatch
 *   *inside* queryModel is reached — `shouldUseVCR()` has to return false when
 *   faux and VCR run in the same test process.
 * - Exit 1 with both streams empty means credential lookup threw. The CI branch
 *   of getAnthropicApiKeyWithSource demands a key, and GitHub Actions sets CI=1.
 *   Nothing is printed, so the empty streams in the message are the only signal.
 */
function expectCleanRun(result: Omit<EvalResult, 'dir'>): void {
  const detail = `exit=${result.exitCode}\nstdout: ${JSON.stringify(
    result.output,
  )}\nstderr: ${JSON.stringify(result.stderr)}`
  expect(result.output).not.toMatch(/fixture missing/i)
  expect(result.exitCode, detail).toBe(0)
}

let lastResult: EvalResult | null = null

afterEach(() => {
  if (lastResult) {
    cleanupEval(lastResult)
    lastResult = null
  }
})

describe('evals harness: text output', () => {
  test('text-only faux turn reaches stdout', async () => {
    const result = await runEvalAndClean({
      prompt: 'Say hello',
      fauxScript: [{ text: 'Hello from the faux provider!' }],
    })
    expectCleanRun(result)
    expect(result.output).toContain('Hello from the faux provider!')
  }, 60_000)

  test('multi-word output is transmitted intact', async () => {
    const phrase = 'the quick brown fox jumps over the lazy dog'
    const result = await runEvalAndClean({
      prompt: 'Recite a pangram',
      fauxScript: [{ text: phrase }],
    })
    expectCleanRun(result)
    expect(result.output).toContain(phrase)
  }, 60_000)

  test('script exhaustion produces a valid response, not a crash', async () => {
    // Empty script → turn 0 immediately exceeds bounds → EXHAUSTED_TURN.
    const result = await runEvalAndClean({
      prompt: 'First and only scripted turn',
      fauxScript: [],
    })
    expectCleanRun(result)
    expect(result.output).toContain('[faux] script exhausted')
  }, 60_000)
})

describe('evals harness: timeout', () => {
  test('reports when the subprocess exceeded its deadline', async () => {
    const result = await runEvalAndClean({
      prompt: 'Wait for the scripted response',
      fauxScript: [{ text: 'too late' }],
      env: { CLAUDE_CODE_FAUX_DELAY_MS: '1000' },
      timeout: 50,
    })

    expect(result.timedOut).toBe(true)
  }, 60_000)
})

describe('evals harness: setup and filesystem', () => {
  test('setup can create fixture files, dir is accessible after the run', async () => {
    lastResult = await runEval({
      prompt: 'Greet me',
      setup(dir) {
        writeFileSync(join(dir, 'fixture.txt'), 'setup ran')
      },
      fauxScript: [{ text: 'greeting delivered' }],
    })
    expectCleanRun(lastResult)
    // Fixture created by setup is still present after the run.
    expect(existsSync(join(lastResult.dir, 'fixture.txt'))).toBe(true)
    expect(readFileSync(join(lastResult.dir, 'fixture.txt'), 'utf8')).toBe(
      'setup ran',
    )
  }, 60_000)

  test('function-form fauxScript receives the temp dir', async () => {
    lastResult = await runEval({
      prompt: 'Check the dir',
      setup(dir) {
        writeFileSync(join(dir, 'check.txt'), 'dir-check-payload')
      },
      // Function form: turns can reference dir-local paths
      fauxScript: dir => [
        {
          text: `I can see the dir is ${dir}`,
        },
      ],
    })
    expectCleanRun(lastResult)
    // The scripted text referenced dir — confirm it reached output.
    expect(lastResult.output).toContain(lastResult.dir)
  }, 60_000)
})
