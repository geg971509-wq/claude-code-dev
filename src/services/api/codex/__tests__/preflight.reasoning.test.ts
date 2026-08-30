import { describe, expect, test } from 'bun:test'
import { sanitizeCodexRequest } from '../preflight.js'

describe('sanitizeCodexRequest reasoning replay', () => {
  test('accepts encrypted reasoning items for stateless replay', () => {
    const out = sanitizeCodexRequest({
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'reasoning',
          encrypted_content: 'encrypted-1',
          summary: [
            { type: 'summary_text', text: 'Inspected the affected files.' },
          ],
        },
      ],
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    } as never)

    expect(out.input as unknown).toEqual([
      {
        type: 'reasoning',
        encrypted_content: 'encrypted-1',
        summary: [
          { type: 'summary_text', text: 'Inspected the affected files.' },
        ],
      },
    ])
  })

  test('rejects reasoning without encrypted content', () => {
    expect(() =>
      sanitizeCodexRequest({
        model: 'gpt-5.6-sol',
        input: [{ type: 'reasoning', summary: [] }],
      } as never),
    ).toThrow('reasoning.encrypted_content must be a string')
  })

  test('rejects malformed reasoning summaries', () => {
    expect(() =>
      sanitizeCodexRequest({
        model: 'gpt-5.6-sol',
        input: [
          {
            type: 'reasoning',
            encrypted_content: 'encrypted-1',
            summary: [{ type: 'text', text: 'wrong shape' }],
          },
        ],
      } as never),
    ).toThrow('reasoning.summary must contain summary_text items')
  })
})
