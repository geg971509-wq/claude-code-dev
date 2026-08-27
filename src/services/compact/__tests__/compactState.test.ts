import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '..', '..', '..', '..')

async function runLifecycle(errorKind: 'abort' | 'failure') {
  const proc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
        import { mock } from 'bun:test'
        import { debugMock } from './tests/mocks/debug.ts'
        import { logMock } from './tests/mocks/log.ts'

        mock.module('bun:bundle', () => ({ feature: () => false }))
        mock.module('src/utils/debug.ts', debugMock)
        mock.module('src/utils/log.ts', logMock)
        const hooks = await import('src/utils/hooks.ts')
        mock.module('src/utils/hooks.ts', () => ({
          ...hooks,
          executePreCompactHooks: async (_input, signal) => {
            if ('${errorKind}' === 'abort') {
              signal.throwIfAborted()
            }
            throw new Error('compact failed')
          },
          executePostCompactHooks: async () => ({}),
        }))

        const { compactConversation } = await import(
          'src/services/compact/compact.ts'
        )
        const { createUserMessage } = await import('src/utils/messages.ts')
        const { getDefaultAppState } = await import('src/state/AppStateStore.ts')
        const controller = new AbortController()
        if ('${errorKind}' === 'abort') controller.abort()
        const states = []
        const progress = []
        const context = {
          options: {
            commands: [],
            debug: false,
            tools: [],
            verbose: false,
            mainLoopModel: 'claude-sonnet-4-20250514',
            thinkingConfig: { type: 'disabled' },
            mcpClients: [],
            mcpResources: {},
            ideInstallationStatus: null,
            isNonInteractiveSession: true,
            agentDefinitions: { activeAgents: [], allAgents: [] },
          },
          abortController: controller,
          getAppState: getDefaultAppState,
          setAppState() {},
          readFileState: new Map(),
          onCompactionState(event) { states.push(event) },
          onCompactProgress(event) { progress.push(event.type) },
          setSDKStatus() {},
          addNotification() {},
        }

        try {
          await compactConversation(
            [createUserMessage({ content: 'hello' })],
            context,
            {},
            false,
          )
        } catch {}
        console.log(JSON.stringify({ states, progress }))
      `,
    ],
    { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
  )
  const code = await proc.exited
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  return JSON.parse(stdout.trim()) as {
    states: Array<{ state: string; revision: number; timestamp: string }>
    progress: string[]
  }
}

describe('compact lifecycle state', () => {
  test('failure closes progress without reporting consumed', async () => {
    const result = await runLifecycle('failure')
    expect(result.states.map(event => event.state)).toEqual([
      'started',
      'failed',
    ])
    expect(result.states[1]!.revision).toBeGreaterThan(
      result.states[0]!.revision,
    )
    expect(result.states.every(event => event.timestamp.length > 0)).toBe(true)
    expect(result.progress).toEqual([
      'hooks_start',
      'compact_start',
      'compact_end',
    ])
  })

  test('abort closes progress without reporting consumed', async () => {
    const result = await runLifecycle('abort')
    expect(result.states.map(event => event.state)).toEqual([
      'started',
      'discarded',
    ])
    expect(result.states[1]!.revision).toBeGreaterThan(
      result.states[0]!.revision,
    )
    expect(result.progress).toEqual([
      'hooks_start',
      'compact_start',
      'compact_end',
    ])
  })
})
