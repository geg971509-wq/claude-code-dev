import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { mkdir, readFile, rm, symlink, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Tool, ToolUseContext, Tools } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

// Only mock modules with process-level side effects. Incomplete partial mocks of
// heavy production modules break transitive named exports under bun:test.
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: async () => {},
  stripProtoFields: <T>(v: T) => v,
  attachAnalyticsSink: () => {},
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

const { runToolUse } = await import('../toolExecution.js')
const { isMalformedToolInput, normalizeContentFromAPI } = await import(
  '../../../utils/messages.js'
)

const testDir = join(process.cwd(), `.tmp-tool-execution-path-${process.pid}`)

beforeAll(async () => {
  await mkdir(testDir, { recursive: true })
})

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function makeTool(name: string): Tool {
  let called = 0
  const tool = {
    name,
    aliases: [],
    inputSchema: {
      safeParse: (input: unknown) => ({ success: true, data: input }),
    },
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    call: async () => {
      called++
      return { data: 'ok' }
    },
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    description: async () => name,
    prompt: async () => name,
    userFacingName: () => name,
    renderToolUseMessage: () => name,
    mapToolResultToToolResultBlockParam: (content: unknown, id: string) => ({
      tool_use_id: id,
      type: 'tool_result' as const,
      content: String(content),
    }),
    maxResultSizeChars: 10_000,
    getCallCount: () => called,
  }
  return tool as unknown as Tool
}

function makeFileMutationTool(): Tool {
  return {
    ...makeTool('Write'),
    isReadOnly: () => false,
    getPath: (input: Record<string, unknown>) => String(input.file_path),
    call: async (input: Record<string, unknown>, context: ToolUseContext) => {
      context.assertMutationPathUnchanged?.()
      await writeFile(
        String((input as { file_path: string }).file_path),
        'changed\n',
      )
      return { data: 'ok' }
    },
  } as unknown as Tool
}

function makeContext(tools: Tools, refreshTools?: () => Tools): ToolUseContext {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools,
      refreshTools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { builtinAgents: [], customAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: {
      get: () => undefined,
      set: () => {},
      delete: () => false,
      has: () => false,
      clear: () => {},
    } as any,
    getAppState: () =>
      ({
        toolPermissionContext: { mode: 'default' },
      }) as any,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

function makeAssistantMessage(
  toolName: string,
  id: string,
  input: Record<string, unknown> = {},
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'assistant-1',
    message: {
      id: 'msg-1',
      content: [
        {
          type: 'tool_use',
          id,
          name: toolName,
          input,
        },
      ],
    },
  } as unknown as AssistantMessage
}

async function collect(
  gen: AsyncGenerator<{ message?: { toolUseResult?: unknown } }, void>,
) {
  const messages: Array<{ toolUseResult?: unknown }> = []
  for await (const update of gen) {
    if (update.message) messages.push(update.message)
  }
  return messages
}

describe('file mutation permission path evidence', () => {
  test.skipIf(process.platform === 'win32')(
    'rejects a symlink target changed while permission is pending',
    async () => {
      const approved = join(testDir, 'approved.txt')
      const outside = join(testDir, 'outside.txt')
      const link = join(testDir, 'target.txt')
      await writeFile(approved, 'original\n')
      await writeFile(outside, 'outside\n')
      await rm(link, { force: true })
      await symlink(approved, link)

      const tool = makeFileMutationTool()
      const ctx = makeContext([tool])
      const input = { file_path: link, content: 'changed\n' }
      const block = {
        type: 'tool_use',
        id: 'tu-path-swap',
        name: 'Write',
        input,
      } as ToolUseBlock

      const messages = await collect(
        runToolUse(
          block,
          makeAssistantMessage('Write', 'tu-path-swap', input),
          async () => {
            await unlink(link)
            await symlink(outside, link)
            return { behavior: 'allow' } as any
          },
          ctx,
          [tool],
        ),
      )

      expect(await readFile(outside, 'utf8')).toBe('outside\n')
      expect(
        messages.some(message =>
          String(message.toolUseResult).includes(
            'File target changed after permission approval',
          ),
        ),
      ).toBe(true)
    },
  )

  test('rejects an approved input whose file path is replaced', async () => {
    const original = join(testDir, 'original-input.txt')
    const replacement = join(testDir, 'replacement-input.txt')
    await writeFile(original, 'original\n')
    await writeFile(replacement, 'replacement\n')

    const tool = makeFileMutationTool()
    const ctx = makeContext([tool])
    const input = { file_path: original, content: 'changed\n' }
    const block = {
      type: 'tool_use',
      id: 'tu-updated-path',
      name: 'Write',
      input,
    } as ToolUseBlock

    const messages = await collect(
      runToolUse(
        block,
        makeAssistantMessage('Write', 'tu-updated-path', input),
        async () =>
          ({
            behavior: 'allow',
            updatedInput: { ...input, file_path: replacement },
          }) as any,
        ctx,
        [tool],
      ),
    )

    expect(await readFile(original, 'utf8')).toBe('original\n')
    expect(await readFile(replacement, 'utf8')).toBe('replacement\n')
    expect(
      messages.some(message =>
        String(message.toolUseResult).includes(
          'File target changed after permission approval',
        ),
      ),
    ).toBe(true)
  })
})

describe('runToolUse request tool identity', () => {
  test('executes when request and current tool are the same object', async () => {
    const tool = makeTool('ProbeTool')
    const ctx = makeContext([tool])
    const block = {
      type: 'tool_use',
      id: 'tu-1',
      name: 'ProbeTool',
      input: {},
    } as ToolUseBlock

    const messages = await collect(
      runToolUse(
        block,
        makeAssistantMessage('ProbeTool', 'tu-1'),
        async () => ({ behavior: 'allow' }) as any,
        ctx,
        [tool],
      ),
    )

    expect((tool as any).getCallCount()).toBe(1)
    expect(
      messages.some(m => String(m.toolUseResult).includes('Stale tool call')),
    ).toBe(false)
  })

  test('executes live tool when same-name definition is rebuilt', async () => {
    const requestTool = makeTool('ProbeTool')
    const currentTool = makeTool('ProbeTool')
    const ctx = makeContext([requestTool], () => [currentTool])
    const block = {
      type: 'tool_use',
      id: 'tu-2',
      name: 'ProbeTool',
      input: {},
    } as ToolUseBlock

    const messages = await collect(
      runToolUse(
        block,
        makeAssistantMessage('ProbeTool', 'tu-2'),
        async () => ({ behavior: 'allow' }) as any,
        ctx,
        [requestTool],
      ),
    )

    expect(
      messages.some(m => String(m.toolUseResult).includes('Stale tool call')),
    ).toBe(false)
    expect((requestTool as any).getCallCount()).toBe(0)
    expect((currentTool as any).getCallCount()).toBe(1)
  })

  test('returns stale when request tool is removed', async () => {
    const requestTool = makeTool('ProbeTool')
    const ctx = makeContext([requestTool], () => [])
    const block = {
      type: 'tool_use',
      id: 'tu-3',
      name: 'ProbeTool',
      input: {},
    } as ToolUseBlock

    const messages = await collect(
      runToolUse(
        block,
        makeAssistantMessage('ProbeTool', 'tu-3'),
        async () => ({ behavior: 'allow' }) as any,
        ctx,
        [requestTool],
      ),
    )

    expect(String(messages[0]?.toolUseResult)).toContain(
      'Stale tool call: ProbeTool',
    )
    expect(String(messages[0]?.toolUseResult)).toContain('no longer available')
    expect((requestTool as any).getCallCount()).toBe(0)
  })

  test('executes tool that appears only in the live pool', async () => {
    const currentTool = makeTool('ProbeTool')
    const ctx = makeContext([], () => [currentTool])
    const block = {
      type: 'tool_use',
      id: 'tu-4',
      name: 'ProbeTool',
      input: {},
    } as ToolUseBlock

    const messages = await collect(
      runToolUse(
        block,
        makeAssistantMessage('ProbeTool', 'tu-4'),
        async () => ({ behavior: 'allow' }) as any,
        ctx,
        [],
      ),
    )

    expect(
      messages.some(m => String(m.toolUseResult).includes('Stale tool call')),
    ).toBe(false)
    expect((currentTool as any).getCallCount()).toBe(1)
  })

  test('rejects malformed streamed JSON before permission or execution', async () => {
    const tool = makeTool('ProbeTool')
    const ctx = makeContext([tool])
    const [normalized] = normalizeContentFromAPI(
      [
        {
          type: 'tool_use',
          id: 'tu-malformed',
          name: 'ProbeTool',
          input: '{bad',
        },
      ] as any,
      [tool],
    )
    const block = normalized as ToolUseBlock
    let permissionCalls = 0

    expect(isMalformedToolInput(block.input)).toBe(true)
    const messages = await collect(
      runToolUse(
        block,
        makeAssistantMessage('ProbeTool', 'tu-malformed'),
        async () => {
          permissionCalls++
          return { behavior: 'allow' } as any
        },
        ctx,
        [tool],
      ),
    )

    const result = (messages[0] as any).message.content[0]
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('InputValidationError')
    expect(String(messages[0]?.toolUseResult)).toContain(
      'Tool input is not valid JSON',
    )
    expect(permissionCalls).toBe(0)
    expect((tool as any).getCallCount()).toBe(0)
  })
})
