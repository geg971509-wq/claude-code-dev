import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')

function runKnip(args: string[]) {
  return Bun.spawnSync({
    cmd: ['bunx', 'knip', ...args],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

function requireSuccess(result: ReturnType<typeof runKnip>): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${result.stdout.toString()}\n${result.stderr.toString()}`.trim(),
    )
  }
}

describe('knip configuration', () => {
  test('has no stale entry or ignore configuration', () => {
    const result = runKnip(['--max-issues', '100000', '--max-show-issues', '1'])

    requireSuccess(result)
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
    for (const staleHint of [
      'Remove from ignore',
      'Remove from ignoreFiles',
      'Remove redundant entry pattern',
      'Refine entry pattern (no matches)',
    ]) {
      expect(output).not.toContain(staleHint)
    }
  }, 30_000)

  test('keeps runtime inputs and host binaries out of issue reports', () => {
    const result = runKnip([
      '--reporter',
      'json',
      '--no-config-hints',
      '--no-exit-code',
    ])
    requireSuccess(result)

    const report = JSON.parse(result.stdout.toString()) as {
      issues: Array<{
        file?: string
        binaries?: Array<{ name: string }>
        files?: Array<{ name: string }>
      }>
    }
    const unused = new Set(
      report.issues.flatMap(issue => issue.files?.map(file => file.name) ?? []),
    )
    const liveEntrypoints = [
      'src/entrypoints/cli.tsx',
      'scripts/dump-prompt.ts',
      'scripts/postinstall.cjs',
      'scripts/setup-chrome-mcp.mjs',
      'src/constants/promptEngineeringAudit.runner.ts',
      'src/services/api/codex/__tests__/request.runner.ts',
      'src/services/api/gemini/__tests__/queryModelGemini.isolated.ts',
      'tests/integration/fixtures/cross-session-peer.runner.ts',
      'packages/remote-control-server/src/index.ts',
      'packages/remote-control-server/web/vite.config.ts',
      'packages/remote-control-server/web/src/main.tsx',
      'packages/workflow-engine/src/index.ts',
      'packages/workflow-engine/scripts/build.ts',
    ]

    for (const path of liveEntrypoints) expect(unused.has(path)).toBe(false)
    const issueFiles = report.issues.flatMap(issue => issue.file ?? [])
    expect(issueFiles.some(path => path.startsWith('.superpowers/'))).toBe(
      false,
    )
    expect([...unused].some(path => path.startsWith('.claude/'))).toBe(false)
    const binaries = new Set(
      report.issues.flatMap(
        issue => issue.binaries?.map(binary => binary.name) ?? [],
      ),
    )
    for (const binary of ['gh', 'ip', 'ps', 'security', 'tasklist']) {
      expect(binaries.has(binary)).toBe(false)
    }
  }, 30_000)
})
