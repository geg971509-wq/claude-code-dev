import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '..', '..', '..', '..')

test('summary precompute has no compact lifecycle side effects', async () => {
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
        let forkCalls = 0
        const forkedAgent = await import('src/utils/forkedAgent.ts')
        mock.module('src/utils/forkedAgent.ts', () => ({
          ...forkedAgent,
          runForkedAgent: async () => {
            forkCalls++
            return {
              messages: [{
                type: 'assistant',
                uuid: '00000000-0000-4000-8000-000000000002',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'prepared summary' }],
                },
              }],
              totalUsage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            }
          },
        }))
        let hookCalls = 0
        const hooks = await import('src/utils/hooks.ts')
        mock.module('src/utils/hooks.ts', () => ({
          ...hooks,
          executePreCompactHooks: async () => {
            hookCalls++
            return {}
          },
          executePostCompactHooks: async () => {
            hookCalls++
            return {}
          },
        }))

        const { emitCompactionState, prepareCompactSummary } = await import(
          'src/services/compact/compact.ts'
        )
        const { PrecomputedCompactManager } = await import(
          'src/services/compact/precomputedCompact.ts'
        )
        const { tryReactiveCompact } = await import(
          'src/services/compact/reactiveCompact.ts'
        )
        const { roughTokenCountEstimationForMessages } = await import(
          'src/services/tokenEstimation.ts'
        )
        const { createUserMessage } = await import('src/utils/messages.ts')
        const { getDefaultAppState } = await import('src/state/AppStateStore.ts')
        const lifecycle = []
        const stateEvents = []
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
          abortController: new AbortController(),
          getAppState: getDefaultAppState,
          setAppState() {},
          readFileState: new Map(),
          onCompactionState(event) {
            stateEvents.push(event)
            lifecycle.push(event.state)
          },
          onCompactProgress(event) { lifecycle.push(event.type) },
          setSDKStatus(status) { lifecycle.push(String(status)) },
          setStreamMode(mode) { lifecycle.push(mode) },
          setResponseLength() { lifecycle.push('response_length') },
        }
        const messages = [createUserMessage({ content: 'hello' })]
        const result = await prepareCompactSummary(
          messages,
          context,
          {},
          new AbortController().signal,
        )
        const beforeConsume = {
          forkCalls,
          hookCalls,
          lifecycle: [...lifecycle],
          summary: result.summary,
          hasBoundary: 'boundaryMarker' in result,
        }
        let clears = 0
        const manager = new PrecomputedCompactManager('session', true, {
          async read() {},
          async write() {},
          async clear() {
            clears++
            if (clears > 1) throw new Error('clear EACCES')
          },
        })
        context.precomputedCompactManager = manager
        await manager.rehydrate(context.options.mainLoopModel, messages)
        await manager.arm(
          'main',
          async () => {
            await new Promise(resolve => setTimeout(resolve, 10))
            return {
              key: 'main',
              status: 'ready',
              sessionId: 'session',
              model: context.options.mainLoopModel,
              precomputedAtUuid: messages.at(-1).uuid,
              preservedUuids: result.messagesToKeep.map(message => message.uuid),
              preCompactTokens: roughTokenCountEstimationForMessages(messages),
              createdAt: Date.now(),
              result,
            }
          },
          event => emitCompactionState(context, event),
        )
        const reactive = await tryReactiveCompact({
          hasAttempted: false,
          querySource: 'repl_main_thread',
          aborted: false,
          messages,
          cacheSafeParams: {
            toolUseContext: context,
            forkContextMessages: messages,
          },
        })
        console.log(JSON.stringify({
          beforeConsume,
          forkCalls,
          hookCalls,
          managerConsumed: manager.get('main') === undefined,
          reactivePrecomputed: reactive?.precomputed ?? false,
          boundaryPrecomputed:
            reactive?.result?.boundaryMarker?.compactMetadata?.precomputed ??
            false,
          compactStarts: lifecycle.filter(event => event === 'compact_start').length,
          compactEnds: lifecycle.filter(event => event === 'compact_end').length,
          sdkStateClosed: lifecycle.at(-1) === '',
          clears,
          precomputeStates: stateEvents
            .filter(event => event.reason?.startsWith('precompute_'))
            .map(event => ({ state: event.state, reason: event.reason })),
          revisionsMonotonic: stateEvents.every(
            (event, index) => index === 0 || event.revision > stateEvents[index - 1].revision,
          ),
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
    beforeConsume: {
      forkCalls: 1,
      hookCalls: 0,
      lifecycle: [],
      summary: 'prepared summary',
      hasBoundary: false,
    },
    forkCalls: 1,
    hookCalls: 2,
    managerConsumed: true,
    reactivePrecomputed: true,
    boundaryPrecomputed: true,
    compactStarts: 1,
    compactEnds: 1,
    sdkStateClosed: true,
    clears: 2,
    precomputeStates: [{ state: 'ready', reason: 'precompute_ready' }],
    revisionsMonotonic: true,
  })
})

test('compact helper queries do not recursively arm precompute', async () => {
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

        const { autoCompactIfNeeded } = await import(
          'src/services/compact/autoCompact.ts'
        )
        let armCalls = 0
        const manager = {
          async rehydrate() {},
          get() {},
          async arm() { armCalls++ },
        }
        const context = {
          options: { mainLoopModel: 'claude-sonnet-4-20250514' },
          effectiveContextWindow: 200000,
          abortController: new AbortController(),
          precomputedCompactManager: manager,
        }
        const messages = [{
          type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000004',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'summary input' }],
            usage: {
              input_tokens: 170000,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }]

        await autoCompactIfNeeded(messages, context, {}, 'compact')
        await autoCompactIfNeeded(messages, context, {}, 'session_memory')
        console.log(JSON.stringify({ armCalls }))
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
  expect(JSON.parse(stdout.trim())).toEqual({ armCalls: 0 })
})
