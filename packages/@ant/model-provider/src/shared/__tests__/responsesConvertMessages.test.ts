import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { createResponsesFallbackCallId } from '../responsesCallIds.js'
import { anthropicMessagesToResponsesInput } from '../responsesConvertMessages.js'

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

describe('anthropicMessagesToResponsesInput images', () => {
  test('preserves text-image-text content order', () => {
    const items = anthropicMessagesToResponsesInput([
      makeUserMsg([
        { type: 'text', text: 'before' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc123',
          },
        },
        { type: 'text', text: 'after' },
      ]),
    ])

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'before' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,abc123',
            detail: 'high',
          },
          { type: 'input_text', text: 'after' },
        ],
      },
    ])
  })

  test('converts local base64 images to data URLs', () => {
    const items = anthropicMessagesToResponsesInput([
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
    const items = anthropicMessagesToResponsesInput([
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
      const items = anthropicMessagesToResponsesInput([
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
      expect(JSON.stringify(items)).not.toContain(url)
    }
  })

  test('keeps remote image URLs when the endpoint supports them', () => {
    const items = anthropicMessagesToResponsesInput(
      [
        makeUserMsg([
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/a.png' },
          },
        ]),
      ],
      { allowRemoteImageUrls: true },
    )

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: 'https://example.com/a.png',
            detail: 'high',
          },
        ],
      },
    ])
  })

  test('omits unprocessable image blocks', () => {
    const items = anthropicMessagesToResponsesInput([
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
    const items = anthropicMessagesToResponsesInput([
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

describe('anthropicMessagesToResponsesInput assistant replay', () => {
  test('preserves tool result placement and call ID pairing', () => {
    const items = anthropicMessagesToResponsesInput([
      makeAssistantMsg([
        { type: 'text', text: 'before call' },
        {
          type: 'tool_use',
          id: 'toolu id/1',
          name: 'Read',
          input: { file_path: '/tmp/a.txt' },
        },
        { type: 'text', text: 'after call' },
      ]),
      makeUserMsg([
        { type: 'text', text: 'before result' },
        {
          type: 'tool_result',
          tool_use_id: 'toolu id/1',
          content: 'result',
        },
        { type: 'text', text: 'after result' },
      ]),
    ])

    expect(items as unknown[]).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'before call', annotations: [] },
        ],
      },
      {
        type: 'function_call',
        call_id: 'toolu_id_1',
        name: 'Read',
        arguments: '{"file_path":"/tmp/a.txt"}',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'after call', annotations: [] }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'before result' }],
      },
      {
        type: 'function_call_output',
        call_id: 'toolu_id_1',
        output: 'result',
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'after result' }],
      },
    ])
  })

  test('keeps normalized call IDs unique after sanitization collisions', () => {
    const items = anthropicMessagesToResponsesInput([
      makeAssistantMsg([
        { type: 'tool_use', id: 'a b', name: 'Read', input: { path: 'a' } },
        { type: 'tool_use', id: 'a/b', name: 'Read', input: { path: 'b' } },
      ]),
      makeUserMsg([
        { type: 'tool_result', tool_use_id: 'a b', content: 'first' },
        { type: 'tool_result', tool_use_id: 'a/b', content: 'second' },
      ]),
    ])
    const calls = items.filter(item => item.type === 'function_call') as Array<{
      call_id: string
    }>
    const outputs = items.filter(
      item => item.type === 'function_call_output',
    ) as Array<{ call_id: string }>

    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(call => call.call_id)).size).toBe(2)
    expect(outputs.map(output => output.call_id)).toEqual(
      calls.map(call => call.call_id),
    )
  })

  test('keeps fallback call IDs unique when the first hash is pre-reserved', () => {
    const firstFallback = createResponsesFallbackCallId(
      'a b:Read:{"path":"collision"}:2:0',
    )
    const ids = ['a_b', firstFallback, 'a b']
    const items = anthropicMessagesToResponsesInput([
      makeAssistantMsg([
        {
          type: 'tool_use',
          id: ids[0],
          name: 'Read',
          input: { path: 'first' },
        },
        {
          type: 'tool_use',
          id: ids[1],
          name: 'Read',
          input: { path: 'reserved' },
        },
        {
          type: 'tool_use',
          id: ids[2],
          name: 'Read',
          input: { path: 'collision' },
        },
      ]),
      makeUserMsg(
        ids.map((id, index) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: `result-${index}`,
        })),
      ),
    ])
    const calls = items.filter(item => item.type === 'function_call') as Array<{
      call_id: string
    }>
    const outputs = items.filter(
      item => item.type === 'function_call_output',
    ) as Array<{ call_id: string }>

    expect(calls).toHaveLength(3)
    expect(new Set(calls.map(call => call.call_id)).size).toBe(3)
    expect(outputs.map(output => output.call_id)).toEqual(
      calls.map(call => call.call_id),
    )
  })

  test('preserves adjacent assistant text blocks exactly', () => {
    const items = anthropicMessagesToResponsesInput([
      makeAssistantMsg([
        { type: 'text', text: '  first  ' },
        { type: 'text', text: 'second' },
      ]),
    ])

    expect(items as unknown[]).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: '  first  ', annotations: [] },
          { type: 'output_text', text: 'second', annotations: [] },
        ],
      },
    ])
  })

  test('replays signed thinking as ordered encrypted reasoning items', () => {
    const items = anthropicMessagesToResponsesInput([
      makeAssistantMsg([
        { type: 'text', text: 'before reasoning' },
        {
          type: 'thinking',
          thinking: 'hidden reasoning',
          signature: 'encrypted-reasoning-1',
        },
        { type: 'text', text: 'before call' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: {},
        },
        {
          type: 'thinking',
          thinking: 'more hidden reasoning',
          signature: 'encrypted-reasoning-2',
        },
        { type: 'text', text: 'after reasoning' },
      ]),
    ])

    expect(items as unknown[]).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'before reasoning', annotations: [] },
        ],
      },
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning-1',
        summary: [{ type: 'summary_text', text: 'hidden reasoning' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'before call', annotations: [] },
        ],
      },
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'Read',
        arguments: '{}',
      },
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-reasoning-2',
        summary: [{ type: 'summary_text', text: 'more hidden reasoning' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'after reasoning', annotations: [] },
        ],
      },
    ])
  })
})
