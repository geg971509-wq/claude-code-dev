import { describe, expect, test } from 'bun:test'
import { sanitizeCodexRequest } from '../preflight.js'

describe('sanitizeCodexRequest', () => {
  test('keeps official sampling extras', () => {
    const out = sanitizeCodexRequest({
      model: 'gpt-5.4',
      input: [],
      store: false,
      stream: true,
      tool_choice: 'auto',
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: false,
    } as never)

    expect(out.include).toEqual(['reasoning.encrypted_content'])
    expect(out.tool_choice).toBe('auto')
    expect(out.store).toBe(false)
    expect((out as { stream?: boolean }).stream).toBe(true)
  })
})
