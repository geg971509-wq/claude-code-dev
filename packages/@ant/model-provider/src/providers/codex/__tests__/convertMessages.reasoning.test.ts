import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '../../../types/message.js'
import { anthropicMessagesToResponsesInput } from '../../../shared/responsesConvertMessages.js'

function makeAssistantMsg(content: any[]): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000001',
    message: { role: 'assistant', content },
  } as AssistantMessage
}

describe('anthropicMessagesToResponsesInput reasoning replay', () => {
  test('preserves encrypted reasoning and summary in original item order', () => {
    const items = anthropicMessagesToResponsesInput([
      makeAssistantMsg([
        {
          type: 'thinking',
          thinking: 'Checked the repository state.',
          signature: 'encrypted-reasoning-1',
        },
        { type: 'text', text: 'I found the issue.' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'Read',
          input: { file_path: '/tmp/a.ts' },
        },
      ]),
    ])

    expect(items as unknown).toEqual([
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning-1',
        summary: [
          {
            type: 'summary_text',
            text: 'Checked the repository state.',
          },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'I found the issue.',
            annotations: [],
          },
        ],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'Read',
        arguments: '{"file_path":"/tmp/a.ts"}',
      },
    ])
  })

  test('replays redacted thinking data as encrypted reasoning', () => {
    const items = anthropicMessagesToResponsesInput([
      makeAssistantMsg([
        {
          type: 'redacted_thinking',
          data: 'encrypted-redacted-reasoning',
        },
      ]),
    ])

    expect(items as unknown).toEqual([
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-redacted-reasoning',
        summary: [],
      },
    ])
  })

  test('does not send unsigned thinking as a reasoning input item', () => {
    const items = anthropicMessagesToResponsesInput([
      makeAssistantMsg([
        { type: 'thinking', thinking: 'local summary only', signature: '' },
        { type: 'text', text: 'answer' },
      ]),
    ])

    expect(items as unknown).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'answer',
            annotations: [],
          },
        ],
      },
    ])
  })
})
