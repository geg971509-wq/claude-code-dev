import { describe, expect, test } from 'bun:test'
import {
  diffValues,
  extractHelpOptions,
  normalizeValue,
  parseLaunchSpec,
  projectRequest,
} from '../claude-parity.js'

describe('parseLaunchSpec', () => {
  test('parses quoted argv without invoking a shell', () => {
    expect(parseLaunchSpec("bun 'path with spaces/cli.js' --flag")).toEqual([
      'bun',
      'path with spaces/cli.js',
      '--flag',
    ])
    expect(() => parseLaunchSpec('bun cli.js; rm -rf /')).toThrow(
      'shell operators are not allowed',
    )
  })
})

describe('normalizeValue', () => {
  test('normalizes only run-generated values', () => {
    expect(
      normalizeValue(
        {
          session_id: '31b49f42-f455-48e1-9300-c0d915a2634b',
          duration_ms: 412,
          time_to_request_ms: 44,
          path: '/tmp/claude-parity-a1b2/config.json',
          endpoint: 'http://127.0.0.1:54321/v1/messages?beta=true',
          usage: { input_tokens: 7, output_tokens: 2 },
          betas: ['context-management-2025-06-27'],
          context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
          error: 'FIXTURE_BAD_REQUEST',
        },
        { tempRoot: '/tmp/claude-parity-a1b2', port: 54321 },
      ),
    ).toEqual({
      session_id: '<ID>',
      duration_ms: '<TIMING>',
      time_to_request_ms: '<TIMING>',
      path: '<TMP>/config.json',
      endpoint: 'http://127.0.0.1:<PORT>/v1/messages?beta=true',
      usage: { input_tokens: 7, output_tokens: 2 },
      betas: ['context-management-2025-06-27'],
      context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
      error: 'FIXTURE_BAD_REQUEST',
    })
  })
})

describe('provider projections', () => {
  test('preserves request order and Claude semantic fields', () => {
    const projection = projectRequest(
      {
        method: 'POST',
        path: '/v1/messages?beta=true',
        headers: {
          'anthropic-beta':
            'claude-code-20250219,context-management-2025-06-27',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'secret',
        },
        body: {
          model: 'claude-sonnet-4-6',
          tools: [{ name: 'Read', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'hello' }],
          context_management: { edits: [] },
        },
      },
      {},
    )

    expect(projection).toEqual({
      method: 'POST',
      path: '/v1/messages?beta=true',
      headers: {
        'anthropic-beta': 'claude-code-20250219,context-management-2025-06-27',
        'anthropic-version': '2023-06-01',
        'x-api-key': '<present>',
      },
      body: {
        model: 'claude-sonnet-4-6',
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'hello' }],
        context_management: { edits: [] },
      },
    })
  })

  test('compares official help as a required subset and reports paths', () => {
    const official = extractHelpOptions(
      '  --alpha  A\n  -b, --beta <value>  B\n',
    )
    const candidate = extractHelpOptions(
      '  --alpha  A\n  --beta <value>  B\n  --extra  E\n',
    )
    expect([...official].every(option => candidate.has(option))).toBe(true)
    expect(diffValues({ usage: 1 }, { usage: 2 })).toEqual([
      '$.usage: official=1 candidate=2',
    ])
  })
})
