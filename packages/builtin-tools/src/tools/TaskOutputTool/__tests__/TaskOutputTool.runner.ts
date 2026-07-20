import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'

mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)
mock.module('src/components/FallbackToolUseErrorMessage.js', () => ({
  FallbackToolUseErrorMessage: () => null,
}))
mock.module('src/components/FallbackToolUseRejectedMessage.js', () => ({
  FallbackToolUseRejectedMessage: () => null,
}))
mock.module('src/components/MessageResponse.js', () => ({
  MessageResponse: () => null,
}))
mock.module('../../AgentTool/UI.js', () => ({
  AgentPromptDisplay: () => null,
  AgentResponseDisplay: () => null,
}))
mock.module('../../BashTool/BashToolResultMessage.js', () => ({
  default: () => null,
}))
mock.module('src/utils/messages.js', () => ({
  extractTextContent: () => '',
}))
mock.module('src/utils/task/framework.js', () => ({
  updateTaskState: () => {},
}))

let persisted: Record<string, unknown> | null = null
let diskOutput = ''
mock.module('src/utils/task/diskOutput.js', () => ({
  readTerminalTaskRecord: async () => persisted,
  getTaskOutput: async () => diskOutput,
  getTaskOutputPath: (id: string) => `/tmp/tasks/${id}.output`,
  getTaskOutputDelta: async () => ({ content: '', newOffset: 0 }),
}))

const { TaskOutputTool } = await import('../TaskOutputTool.js')

let state: { tasks: Record<string, any> }
function context() {
  return {
    getAppState: () => state,
    setAppState: (update: (current: typeof state) => typeof state) => {
      state = update(state)
    },
    abortController: new AbortController(),
  } as never
}

beforeEach(() => {
  state = { tasks: {} }
  persisted = null
  diskOutput = ''
})

describe('TaskOutputTool', () => {
  test('keeps empty-ID validation but accepts IDs outside the live registry', async () => {
    expect(
      await TaskOutputTool.validateInput?.({ task_id: '' } as never, context()),
    ).toMatchObject({ result: false })
    expect(
      await TaskOutputTool.validateInput?.(
        { task_id: 'a1234567890abcde' } as never,
        context(),
      ),
    ).toEqual({ result: true })
  })

  test('returns persisted terminal output after live task eviction', async () => {
    persisted = {
      version: 1,
      id: 'a1234567890abcde',
      type: 'local_agent',
      status: 'completed',
      description: 'inspect code',
      startTime: 1,
      endTime: 2,
      prompt: 'inspect',
      result: 'final answer',
    }
    diskOutput = 'raw transcript'

    const result = await TaskOutputTool.call(
      { task_id: 'a1234567890abcde', block: true, timeout: 100 } as never,
      context(),
      undefined as never,
      undefined as never,
    )

    expect(result.data).toMatchObject({
      retrieval_status: 'success',
      task: {
        task_id: 'a1234567890abcde',
        status: 'completed',
        output: 'final answer',
        prompt: 'inspect',
      },
    })
  })

  test('returns structured not_found for an unknown ID', async () => {
    const result = await TaskOutputTool.call(
      { task_id: 'a000000000000000', block: false, timeout: 0 } as never,
      context(),
      undefined as never,
      undefined as never,
    )

    expect(result.data).toEqual({
      retrieval_status: 'not_found',
      task: null,
    })
  })

  test('keeps timeout distinct from not_found for a live task', async () => {
    state.tasks['b12345678'] = {
      id: 'b12345678',
      type: 'local_bash',
      status: 'running',
      description: 'long command',
      startTime: 1,
      outputOffset: 0,
      notified: false,
      shellCommand: null,
    }
    diskOutput = 'partial output'

    const result = await TaskOutputTool.call(
      { task_id: 'b12345678', block: true, timeout: 0 } as never,
      context(),
      undefined as never,
      undefined as never,
    )

    expect(result.data).toMatchObject({
      retrieval_status: 'timeout',
      task: { status: 'running', output: 'partial output' },
    })
  })

  test('rereads persisted completion when a live task is evicted while waiting', async () => {
    state.tasks['a1234567890abcde'] = {
      id: 'a1234567890abcde',
      type: 'local_agent',
      status: 'running',
      description: 'inspect code',
      startTime: 1,
      outputOffset: 0,
      notified: false,
      prompt: 'inspect',
    }
    setTimeout(() => {
      state.tasks = {}
      persisted = {
        version: 1,
        id: 'a1234567890abcde',
        type: 'local_agent',
        status: 'completed',
        description: 'inspect code',
        startTime: 1,
        endTime: 2,
        result: 'completed while waiting',
      }
    }, 10)

    const result = await TaskOutputTool.call(
      { task_id: 'a1234567890abcde', block: true, timeout: 500 } as never,
      context(),
      undefined as never,
      undefined as never,
    )

    expect(result.data).toMatchObject({
      retrieval_status: 'success',
      task: { status: 'completed', output: 'completed while waiting' },
    })
  })
})
