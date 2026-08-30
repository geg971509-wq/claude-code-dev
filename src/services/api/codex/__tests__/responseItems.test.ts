import { describe, expect, test } from 'bun:test'
import type { Response } from 'openai/resources/responses/responses.mjs'
import { responseToCodexAssistantBlocks } from '../responseItems.js'

function makeResponse(output: unknown[], outputText = ''): Response {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: 'gpt-5.6-sol',
    output,
    output_text: outputText,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 2,
    },
  } as unknown as Response
}

describe('responseToCodexAssistantBlocks', () => {
  test('preserves reasoning, text, and tool calls in response order', () => {
    const blocks = responseToCodexAssistantBlocks(
      makeResponse([
        {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'encrypted-1',
          summary: [
            { type: 'summary_text', text: 'Inspected the files.' },
            { type: 'summary_text', text: 'Selected a minimal fix.' },
          ],
        },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Applying the fix.',
              annotations: [],
            },
          ],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'Edit',
          arguments: '{"file_path":"/tmp/a.ts"}',
          status: 'completed',
        },
      ]),
    )

    expect(blocks).toEqual([
      {
        type: 'thinking',
        thinking: 'Inspected the files.\n\nSelected a minimal fix.',
        signature: 'encrypted-1',
      },
      { type: 'text', text: 'Applying the fix.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'Edit',
        input: '{"file_path":"/tmp/a.ts"}',
      },
    ])
  })

  test('keeps a reasoning signature even when the summary is empty', () => {
    expect(
      responseToCodexAssistantBlocks(
        makeResponse([
          {
            type: 'reasoning',
            encrypted_content: 'encrypted-only',
            summary: [],
          },
        ]),
      ),
    ).toEqual([
      {
        type: 'thinking',
        thinking: '',
        signature: 'encrypted-only',
      },
    ])
  })

  test('uses output_text only when structured answer items are absent', () => {
    expect(responseToCodexAssistantBlocks(makeResponse([], 'fallback'))).toEqual([
      { type: 'text', text: 'fallback' },
    ])
  })
})
