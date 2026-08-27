import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '..', '..', '..', '..')

test('proactive compact falls back to live work after a sidecar read failure', async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
        import { mock } from 'bun:test'
        import { debugMock } from './tests/mocks/debug.ts'
        import { logMock } from './tests/mocks/log.ts'

        mock.module('bun:bundle', () => ({
          feature: name => name === 'PRECOMPUTED_COMPACT',
        }))
        mock.module('src/utils/debug.ts', debugMock)
        mock.module('src/utils/log.ts', logMock)
        const growthbook = await import('src/services/analytics/growthbook.ts')
        mock.module('src/services/analytics/growthbook.ts', () => ({
          ...growthbook,
          getFeatureValue_CACHED_MAY_BE_STALE: () => true,
        }))
        mock.module('src/utils/forkedAgent.ts', () => ({
          createCacheSafeParams: () => ({}),
          createGetAppStateWithAllowedTools: getAppState => getAppState,
          prepareForkedCommandContext: async () => ({}),
          extractResultText: () => '',
          createSubagentContext: context => context,
          runForkedAgent: async () => ({
            messages: [{
              type: 'assistant',
              uuid: '00000000-0000-4000-8000-000000000003',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'live summary' }],
              },
            }],
            totalUsage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }),
        }))
        const hooks = await import('src/utils/hooks.ts')
        mock.module('src/utils/hooks.ts', () => ({
          ...hooks,
          executePreCompactHooks: async () => ({}),
          executePostCompactHooks: async () => ({}),
        }))

        const { autoCompactIfNeeded } = await import(
          'src/services/compact/autoCompact.ts'
        )
        const { PrecomputedCompactManager } = await import(
          'src/services/compact/precomputedCompact.ts'
        )
        const { createUserMessage } = await import('src/utils/messages.ts')
        const { getDefaultAppState } = await import('src/state/AppStateStore.ts')
        const model = 'claude-sonnet-4-20250514'
        const lifecycle = []
        let reads = 0
        const manager = new PrecomputedCompactManager('session', true, {
          async read() {
            reads++
            throw new Error('read EACCES')
          },
          async write() {},
          async clear() {},
        })
        const context = {
          effectiveContextWindow: 20_000,
          precomputedCompactManager: manager,
          options: {
            commands: [],
            debug: false,
            tools: [],
            verbose: false,
            mainLoopModel: model,
            thinkingConfig: { type: 'disabled' },
            mcpClients: [],
            mcpResources: {},
            ideInstallationStatus: null,
            isNonInteractiveSession: true,
            agentDefinitions: { activeAgents: [], allAgents: [] },
            querySource: 'repl_main_thread',
          },
          abortController: new AbortController(),
          getAppState: getDefaultAppState,
          setAppState() {},
          readFileState: new Map(),
          onCompactionState(event) { lifecycle.push(event.state) },
          onCompactProgress(event) { lifecycle.push(event.type) },
          setSDKStatus(status) { lifecycle.push(String(status)) },
          setStreamMode(mode) { lifecycle.push(mode) },
          setResponseLength() { lifecycle.push('response_length') },
        }
        const messages = [
          createUserMessage({ content: 'hello' }),
          {
            type: 'assistant',
            uuid: '00000000-0000-4000-8000-000000000004',
            message: {
              id: 'msg_live',
              type: 'message',
              role: 'assistant',
              model,
              content: [{ type: 'text', text: 'response' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: 15_000,
                output_tokens: 100,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        ]
        let result
        let error = null
        try {
          result = await autoCompactIfNeeded(
            messages,
            context,
            { toolUseContext: context, forkContextMessages: messages },
            'repl_main_thread',
          )
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught)
        }
        console.log(JSON.stringify({
          error,
          reads,
          kind: result?.kind,
          hasBoundary: result?.kind === 'compacted' && !!result.result.boundaryMarker,
          compactStarts: lifecycle.filter(event => event === 'compact_start').length,
          compactEnds: lifecycle.filter(event => event === 'compact_end').length,
          sdkStateClosed: lifecycle.at(-1) === '',
        }))
      `,
    ],
    { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
  )
  const code = await proc.exited
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout.trim())).toEqual({
    error: null,
    reads: 1,
    kind: 'compacted',
    hasBoundary: true,
    compactStarts: 1,
    compactEnds: 1,
    sdkStateClosed: true,
  })
}, 15_000)
