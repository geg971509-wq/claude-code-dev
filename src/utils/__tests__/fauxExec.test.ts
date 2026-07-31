import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { logMock } from '../../../tests/mocks/log'

mock.module('src/utils/log.ts', logMock)

const { parseFauxExecScript, resetFauxExecScriptCache, resolveFauxExec } =
  await import('../fauxExec.js')
const { getFauxExecScriptPath } = await import('../envUtils.js')

const tempDirs = new Set<string>()
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'execFileNoThrow.fauxLoad.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

function scriptFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'faux-exec-'))
  tempDirs.add(dir)
  const path = join(dir, 'script.json')
  writeFileSync(
    path,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  )
  return path
}

beforeEach(() => {
  resetFauxExecScriptCache()
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_USE_FAUX_EXEC
  delete process.env.CLAUDE_CODE_FAUX_EXEC_SCRIPT
  resetFauxExecScriptCache()
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.clear()
})

describe('getFauxExecScriptPath', () => {
  test('is off unless both vars are set', () => {
    expect(getFauxExecScriptPath()).toBeUndefined()

    process.env.CLAUDE_CODE_FAUX_EXEC_SCRIPT = '/tmp/x.json'
    expect(getFauxExecScriptPath()).toBeUndefined()

    process.env.CLAUDE_CODE_USE_FAUX_EXEC = '1'
    expect(getFauxExecScriptPath()).toBe('/tmp/x.json')
  })

  test('only exactly "1" enables it, so an inherited truthy value cannot', () => {
    process.env.CLAUDE_CODE_FAUX_EXEC_SCRIPT = '/tmp/x.json'
    for (const value of ['true', 'yes', 'on', '0', '']) {
      process.env.CLAUDE_CODE_USE_FAUX_EXEC = value
      expect(getFauxExecScriptPath()).toBeUndefined()
    }
  })

  test('an empty script path does not enable it', () => {
    process.env.CLAUDE_CODE_USE_FAUX_EXEC = '1'
    process.env.CLAUDE_CODE_FAUX_EXEC_SCRIPT = ''
    expect(getFauxExecScriptPath()).toBeUndefined()
  })
})

describe('parseFauxExecScript', () => {
  test('accepts a bare array as shorthand for { commands }', () => {
    expect(parseFauxExecScript('[{"file":"git"}]')).toEqual({
      commands: [{ file: 'git' }],
    })
  })

  test('accepts the { commands } object form', () => {
    expect(parseFauxExecScript('{"commands":[{"file":"git"}]}')).toEqual({
      commands: [{ file: 'git' }],
    })
  })

  test('rejects invalid JSON, naming the parse failure', () => {
    expect(() => parseFauxExecScript('{ not json')).toThrow('not valid JSON')
  })

  test('rejects a non-array commands field', () => {
    expect(() => parseFauxExecScript('{"commands":"nope"}')).toThrow(
      'expected an array of commands',
    )
  })

  test('rejects an entry without a file', () => {
    expect(() => parseFauxExecScript('[{"args":[]}]')).toThrow(
      'command 0: "file" must be a non-empty string',
    )
  })

  test('rejects an empty file, which would match nothing', () => {
    expect(() => parseFauxExecScript('[{"file":""}]')).toThrow(
      'command 0: "file" must be a non-empty string',
    )
  })

  test('rejects non-string args entries', () => {
    expect(() => parseFauxExecScript('[{"file":"git","args":[1]}]')).toThrow(
      'command 0: "args" must be an array of strings',
    )
  })

  test('rejects a non-number code', () => {
    expect(() => parseFauxExecScript('[{"file":"git","code":"1"}]')).toThrow(
      'command 0: "code" must be a number',
    )
  })
})

describe('resolveFauxExec', () => {
  test('returns the scripted stdout with code 0 by default', () => {
    const path = scriptFile([
      { file: 'git', args: ['rev-parse', 'HEAD'], stdout: 'abc123\n' },
    ])
    expect(resolveFauxExec(path, 'git', ['rev-parse', 'HEAD'])).toEqual({
      stdout: 'abc123\n',
      stderr: '',
      code: 0,
    })
  })

  test('a non-zero code carries an error string, matching the real wrapper', () => {
    const path = scriptFile([
      { file: 'git', args: ['status'], code: 128, stderr: 'not a repo' },
    ])
    const result = resolveFauxExec(path, 'git', ['status'])
    expect(result.code).toBe(128)
    expect(result.stderr).toBe('not a repo')
    expect(result.error).toContain('128')
  })

  test('an entry without args matches any args for that file', () => {
    const path = scriptFile([{ file: 'gh', stdout: 'gh version 2.0.0' }])
    expect(resolveFauxExec(path, 'gh', ['--version']).stdout).toBe(
      'gh version 2.0.0',
    )
    expect(resolveFauxExec(path, 'gh', ['gist', 'create']).stdout).toBe(
      'gh version 2.0.0',
    )
  })

  test('args must match exactly — a prefix does not count', () => {
    const path = scriptFile([
      { file: 'git', args: ['rev-parse'], stdout: 'matched' },
    ])
    expect(resolveFauxExec(path, 'git', ['rev-parse']).stdout).toBe('matched')
    expect(resolveFauxExec(path, 'git', ['rev-parse', 'HEAD']).code).toBe(1)
  })

  test('the first matching entry wins', () => {
    const path = scriptFile([
      { file: 'git', args: ['x'], stdout: 'first' },
      { file: 'git', args: ['x'], stdout: 'second' },
    ])
    expect(resolveFauxExec(path, 'git', ['x']).stdout).toBe('first')
    expect(resolveFauxExec(path, 'git', ['x']).stdout).toBe('first')
  })

  test('"once" consumes the entry, so successive calls can differ', () => {
    const path = scriptFile([
      { file: 'git', args: ['x'], stdout: 'first', once: true },
      { file: 'git', args: ['x'], stdout: 'second' },
    ])
    expect(resolveFauxExec(path, 'git', ['x']).stdout).toBe('first')
    expect(resolveFauxExec(path, 'git', ['x']).stdout).toBe('second')
    expect(resolveFauxExec(path, 'git', ['x']).stdout).toBe('second')
  })

  test('an unmatched command fails loudly instead of falling through', () => {
    const path = scriptFile([{ file: 'git', args: ['x'] }])
    const result = resolveFauxExec(path, 'curl', ['https://example.com'])
    expect(result.code).toBe(1)
    expect(result.error).toContain('no scripted result for')
    // The printable command aids debugging a mis-keyed script.
    expect(result.error).toContain('curl https://example.com')
  })

  test('a missing script file yields a failed result, never a throw', () => {
    const result = resolveFauxExec('/nonexistent/faux-exec.json', 'git', [])
    expect(result.code).toBe(1)
    expect(result.error).toContain('[faux exec]')
  })

  test('a malformed script yields a failed result naming the problem', () => {
    const path = scriptFile('{ not json')
    const result = resolveFauxExec(path, 'git', [])
    expect(result.code).toBe(1)
    expect(result.error).toContain('not valid JSON')
  })

  test('a malformed script reports on every call, not just the first', () => {
    const path = scriptFile('{ not json')
    expect(resolveFauxExec(path, 'git', []).code).toBe(1)
    expect(resolveFauxExec(path, 'git', []).error).toContain('not valid JSON')
  })
})

describe('execFileNoThrowWithCwd', () => {
  test('converts a faux module load failure into a failed result', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = (stderr + '\n' + stdout).slice(-3000)
      throw new Error(
        `execFileNoThrow faux-load subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
