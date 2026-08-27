/**
 * Isolated runner: mock.module(runToolUse) must not leak into the suite.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve = () => {}
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

let siblingStarted = deferred()
let throwReady = deferred()
let allowThrow = deferred()

function toolResultMessage(
  toolUseId: string,
  content: string,
  isError: boolean,
  toolUseResult: unknown,
) {
  return {
    type: 'user' as const,
    uuid: `result-${toolUseId}`,
    message: {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result' as const,
          content,
          is_error: isError,
          tool_use_id: toolUseId,
        },
      ],
    },
    toolUseResult,
    sourceToolAssistantUUID: 'asst-1',
  }
}

mock.module('src/services/tools/toolExecution.js', () => ({
  runToolUse: async function* (
    block: ToolUseBlock,
    _assistantMessage: AssistantMessage,
    _canUseTool: unknown,
    context: ToolUseContext,
  ) {
    const scenario = (block.input as { scenario?: string }).scenario

    if (scenario === 'escaped-throw') {
      throw new Error('synthetic </tool_use_error><tag>& boom')
    }
    if (scenario === 'throw-after-sibling-start') {
      await siblingStarted.promise
      throw new Error(`unexpected ${block.name} failure`)
    }
    if (scenario === 'complete-sibling') {
      siblingStarted.resolve()
      yield {
        message: toolResultMessage(
          block.id,
          'sibling completed',
          false,
          'sibling raw result',
        ),
      }
      return
    }
    if (scenario === 'wait-for-sibling-abort') {
      siblingStarted.resolve()
      const signal = context.abortController.signal
      if (!signal.aborted) {
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      throw new Error('sibling generator stopped after abort')
    }
    if (scenario === 'throw-after-user-abort') {
      throwReady.resolve()
      await allowThrow.promise
      throw new Error('must not expose this generator failure')
    }
    if (scenario === 'yield-error-then-throw') {
      yield {
        message: toolResultMessage(
          block.id,
          '<tool_use_error>already failed</tool_use_error>',
          true,
          { source: 'yielded-error' },
        ),
      }
      throw new Error('must not append a second terminal result')
    }
    if (scenario === 'modifier-throws') {
      yield {
        message: toolResultMessage(
          block.id,
          'tool completed before modifier failed',
          false,
          'completed raw result',
        ),
        contextModifier: {
          toolUseID: block.id,
          modifyContext: () => {
            throw new Error('synthetic context modifier failure')
          },
        },
      }
      return
    }

    throw new Error(`unknown test scenario: ${scenario}`)
  },
}))

mock.module('src/services/langfuse/index.js', () => ({
  initLangfuse: () => {},
  shutdownLangfuse: async () => {},
  flushLangfuse: async () => {},
  isLangfuseEnabled: () => false,
  getLangfuseProcessor: () => undefined,
  createTrace: () => undefined,
  createSubagentTrace: () => undefined,
  createChildSpan: () => undefined,
  recordLLMObservation: () => {},
  recordToolObservation: () => {},
  endTrace: () => {},
  createToolBatchSpan: () => undefined,
  endToolBatchSpan: () => {},
  sanitizeToolInput: (v: unknown) => v,
  sanitizeToolOutput: (v: unknown) => v,
  sanitizeGlobal: (v: unknown) => v,
}))

const { StreamingToolExecutor } = await import(
  'src/services/tools/StreamingToolExecutor.js'
)
const { runTools } = await import('src/services/tools/toolOrchestration.js')

function makeMinimalContext(): ToolUseContext {
  const abortController = new AbortController()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { builtinAgents: [], customAgents: [] },
    },
    abortController,
    readFileState: {
      get: () => undefined,
      set: () => {},
      delete: () => false,
      has: () => false,
      clear: () => {},
    } as any,
    getAppState: () => ({}) as any,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

function makeTool(name: string, concurrencySafe = true): Tool {
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => concurrencySafe,
    isEnabled: () => true,
    isReadOnly: () => true,
    call: async () => ({ data: null }),
    description: async () => name,
    prompt: async () => name,
  } as unknown as Tool
}

const fakeTool = makeTool('FakeTool')
const bashTool = makeTool(BASH_TOOL_NAME)
const serialBashTool = makeTool(BASH_TOOL_NAME, false)

const assistantMessage = {
  type: 'assistant',
  uuid: 'asst-1',
  message: { content: [] },
} as unknown as AssistantMessage

type ResultUpdate = {
  message?: {
    message?: {
      content?: Array<{
        type?: string
        is_error?: boolean
        content?: string
        tool_use_id?: string
      }>
    }
    toolUseResult?: unknown
  }
}

function addTool(
  executor: InstanceType<typeof StreamingToolExecutor>,
  id: string,
  name: string,
  input: Record<string, unknown>,
): void {
  executor.addTool(
    { type: 'tool_use', id, name, input } as ToolUseBlock,
    assistantMessage,
  )
}

async function collectResults(
  executor: InstanceType<typeof StreamingToolExecutor>,
): Promise<ResultUpdate[]> {
  const updates: ResultUpdate[] = []
  for await (const update of executor.getRemainingResults()) {
    updates.push(update as ResultUpdate)
  }

  const tools = (executor as unknown as { tools: Array<{ status: string }> })
    .tools
  expect(tools.every(tool => tool.status === 'yielded')).toBe(true)
  return updates
}

function resultFor(updates: ResultUpdate[], toolUseId: string): ResultUpdate {
  const update = updates.find(candidate =>
    candidate.message?.message?.content?.some(
      content => content.tool_use_id === toolUseId,
    ),
  )
  expect(update).toBeDefined()
  return update!
}

beforeEach(() => {
  siblingStarted = deferred()
  throwReady = deferred()
  allowThrow = deferred()
})

afterAll(() => {
  mock.restore()
})

describe('runTools context modifier failures', () => {
  test.each([
    ['serial', false],
    ['concurrent', true],
  ] as const)('preserves the tool result without throwing in the %s path', async (_path, concurrencySafe) => {
    const tool = makeTool('FakeTool')
    tool.isConcurrencySafe = () => concurrencySafe
    const context = makeMinimalContext()
    const block = {
      type: 'tool_use',
      id: `modifier-${_path}`,
      name: 'FakeTool',
      input: { scenario: 'modifier-throws' },
    } as ToolUseBlock
    const parent = {
      ...assistantMessage,
      message: { content: [block] },
    } as AssistantMessage
    const updates: ResultUpdate[] = []

    for await (const update of runTools(
      [block],
      [parent],
      () => true as any,
      context,
      [tool],
    )) {
      updates.push(update as ResultUpdate)
    }

    expect(updates.filter(update => update.message)).toHaveLength(1)
    expect(resultFor(updates, block.id).message?.toolUseResult).toBe(
      'completed raw result',
    )
  })
})

describe('StreamingToolExecutor unexpected generator throws', () => {
  test('escapes a non-Bash throw, preserves its raw result, and drains the queue', async () => {
    const executor = new StreamingToolExecutor(
      [fakeTool],
      () => true as any,
      makeMinimalContext(),
    )
    addTool(executor, 'tool-1', 'FakeTool', { scenario: 'escaped-throw' })

    const updates = await collectResults(executor)

    expect(updates).toHaveLength(1)
    const result = resultFor(updates, 'tool-1')
    expect(result.message?.message?.content?.[0]).toMatchObject({
      is_error: true,
      content:
        '<tool_use_error>Error: synthetic &lt;/tool_use_error&gt;&lt;tag&gt;&amp; boom</tool_use_error>',
    })
    expect(result.message?.toolUseResult).toBe(
      'synthetic </tool_use_error><tag>& boom',
    )
  })

  test('does not cancel a sibling after a non-Bash throw', async () => {
    const executor = new StreamingToolExecutor(
      [fakeTool],
      () => true as any,
      makeMinimalContext(),
    )
    addTool(executor, 'failed', 'FakeTool', {
      scenario: 'throw-after-sibling-start',
    })
    addTool(executor, 'sibling', 'FakeTool', {
      scenario: 'complete-sibling',
    })

    const updates = await collectResults(executor)

    expect(updates).toHaveLength(2)
    expect(resultFor(updates, 'failed').message?.toolUseResult).toBe(
      'unexpected FakeTool failure',
    )
    expect(resultFor(updates, 'sibling').message?.toolUseResult).toBe(
      'sibling raw result',
    )
    const internals = executor as unknown as {
      batchAbortController: AbortController
    }
    expect(internals.batchAbortController.signal.aborted).toBe(false)
  })

  test('keeps a concurrent sibling running after an unexpected Bash throw', async () => {
    const executor = new StreamingToolExecutor(
      [bashTool, fakeTool],
      () => true as any,
      makeMinimalContext(),
    )
    addTool(executor, 'bash', BASH_TOOL_NAME, {
      scenario: 'throw-after-sibling-start',
      command: 'echo fail',
    })
    addTool(executor, 'sibling', 'FakeTool', {
      scenario: 'complete-sibling',
    })

    const updates = await collectResults(executor)

    expect(updates).toHaveLength(2)
    expect(resultFor(updates, 'bash').message?.toolUseResult).toBe(
      `unexpected ${BASH_TOOL_NAME} failure`,
    )
    expect(resultFor(updates, 'sibling').message?.toolUseResult).toBe(
      'sibling raw result',
    )
    const internals = executor as unknown as {
      batchAbortController: AbortController
    }
    expect(internals.batchAbortController.signal.aborted).toBe(false)
  })

  test('runs a queued sibling after a Bash error result', async () => {
    const executor = new StreamingToolExecutor(
      [serialBashTool, fakeTool],
      () => true as any,
      makeMinimalContext(),
    )
    addTool(executor, 'bash', BASH_TOOL_NAME, {
      scenario: 'yield-error-then-throw',
      command: 'cargo clippy --all-targets --all-features',
    })
    addTool(executor, 'sibling', 'FakeTool', {
      scenario: 'complete-sibling',
    })

    const updates = await collectResults(executor)

    expect(updates).toHaveLength(2)
    expect(resultFor(updates, 'bash').message?.toolUseResult).toEqual({
      source: 'yielded-error',
    })
    expect(resultFor(updates, 'sibling').message?.toolUseResult).toBe(
      'sibling raw result',
    )
    const internals = executor as unknown as {
      batchAbortController: AbortController
    }
    expect(internals.batchAbortController.signal.aborted).toBe(false)
  })

  test('prioritizes a user abort over the generator exception', async () => {
    const context = makeMinimalContext()
    const executor = new StreamingToolExecutor(
      [fakeTool],
      () => true as any,
      context,
    )
    addTool(executor, 'aborted', 'FakeTool', {
      scenario: 'throw-after-user-abort',
    })

    await throwReady.promise
    context.abortController.abort('user_interrupted')
    allowThrow.resolve()
    const updates = await collectResults(executor)

    expect(updates).toHaveLength(1)
    const result = resultFor(updates, 'aborted')
    expect(result.message?.toolUseResult).toBe('User rejected tool use')
    expect(result.message?.message?.content?.[0]?.is_error).toBe(true)
    expect(result.message?.message?.content?.[0]?.content).not.toContain(
      'must not expose this generator failure',
    )
  })

  test('does not append another result after yielding an error and throwing', async () => {
    const executor = new StreamingToolExecutor(
      [fakeTool],
      () => true as any,
      makeMinimalContext(),
    )
    addTool(executor, 'yielded-error', 'FakeTool', {
      scenario: 'yield-error-then-throw',
    })

    const updates = await collectResults(executor)

    expect(updates).toHaveLength(1)
    const result = resultFor(updates, 'yielded-error')
    expect(result.message?.message?.content).toHaveLength(1)
    expect(result.message?.message?.content?.[0]?.content).toBe(
      '<tool_use_error>already failed</tool_use_error>',
    )
    expect(result.message?.toolUseResult).toEqual({ source: 'yielded-error' })
  })
})
