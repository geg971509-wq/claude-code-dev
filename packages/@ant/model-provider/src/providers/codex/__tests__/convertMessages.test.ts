import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, UserMessage } from '../../../types/message.js'
import { anthropicMessagesToCodexInput } from '../convertMessages.js'

function makeUserMsg(content: string | any[]): UserMessage {
  return {
    type: 'user',
    uuid: '00000000-0000-0000-0000-000000000000',
    message: { role: 'user', content },
  } as UserMessage
}

function makeAssistantMsg(content: string | any[]): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000001',
    message: { role: 'assistant', content },
  } as AssistantMessage
}

describe('anthropicMessagesToCodexInput images', () => {
  test('converts local base64 images to data URLs', () => {
    const items = anthropicMessagesToCodexInput([
      makeUserMsg([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc123',
          },
        },
      ]),
    ])

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,abc123',
            detail: 'high',
          },
        ],
      },
    ])
  })

  test('keeps existing data URLs', () => {
    const items = anthropicMessagesToCodexInput([
      makeUserMsg([
        {
          type: 'image',
          source: {
            type: 'url',
            url: 'data:image/jpeg;base64,xyz',
          },
        },
      ]),
    ])

    const content = (items[0] as { content: Array<{ image_url?: string }> })
      .content
    expect(content[0]?.image_url).toBe('data:image/jpeg;base64,xyz')
  })

  test('omits remote http(s) image URLs', () => {
    for (const url of [
      'https://i.ibb.co/example.png',
      'HTTP://example.com/a.png',
    ]) {
      const items = anthropicMessagesToCodexInput([
        makeUserMsg([
          {
            type: 'image',
            source: {
              type: 'url',
              url,
            },
          },
        ]),
      ])

      expect(items).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'image content omitted because remote image URLs are not supported',
            },
          ],
        },
      ])
    }
  })

  test('omits unprocessable image blocks', () => {
    const items = anthropicMessagesToCodexInput([
      makeUserMsg([{ type: 'image' }]),
    ])

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'image content omitted because it could not be processed',
          },
        ],
      },
    ])
  })

  test('converts tool_result images to data URLs', () => {
    const items = anthropicMessagesToCodexInput([
      makeAssistantMsg([
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: '/tmp/a.png' },
        },
      ]),
      makeUserMsg([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: 'deadbeef',
              },
            },
          ],
        },
      ]),
    ])

    const output = items.find(item => item.type === 'function_call_output') as {
      output?: Array<{ type?: string; image_url?: string; detail?: string }>
    }
    expect(output.output).toEqual([
      {
        type: 'input_image',
        image_url: 'data:image/jpeg;base64,deadbeef',
        detail: 'high',
      },
    ])
  })
})
