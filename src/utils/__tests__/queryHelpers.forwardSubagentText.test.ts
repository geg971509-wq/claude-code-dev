import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { createAssistantMessage } from '../messages.js'
import { normalizeMessage } from '../queryHelpers.js'

function agentProgressMessage(): Message {
  return {
    type: 'progress',
    data: {
      type: 'agent_progress',
      message: createAssistantMessage({ content: 'subagent output' }),
      elapsedTimeSeconds: 1,
      taskId: 'task-1',
    },
    parentToolUseID: 'toolu-parent',
    toolUseID: 'toolu-progress',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-01-01T00:00:00.000Z',
  } as unknown as Message
}

describe('normalizeMessage subagent forwarding', () => {
  test('emits nested agent text only when forwarding is enabled', () => {
    const progress = agentProgressMessage()

    expect([...normalizeMessage(progress, false)]).toEqual([])
    expect([...normalizeMessage(progress, true)]).toMatchObject([
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu-parent',
        message: { content: [{ type: 'text', text: 'subagent output' }] },
      },
    ])
  })
})
