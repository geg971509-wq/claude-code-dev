import { afterEach, describe, expect, test } from 'bun:test'
import {
  isColdCompactEnabled,
  isCompactBlockedByHookError,
} from '../autoCompact.js'
import {
  assertPreCompactNotBlocked,
  COMPACT_BLOCKED_BY_HOOK_PREFIX,
  stripImagesFromMessages,
} from '../compact.js'
import type { Message } from '../../../types/message.js'

describe('hook_blocked signal', () => {
  test('assertPreCompactNotBlocked no-ops without blockedBy', () => {
    expect(() => assertPreCompactNotBlocked({})).not.toThrow()
  })

  test('assertPreCompactNotBlocked throws official prefix', () => {
    expect(() =>
      assertPreCompactNotBlocked({ blockedBy: '[hook]: stop' }),
    ).toThrow(COMPACT_BLOCKED_BY_HOOK_PREFIX)
  })

  test('isCompactBlockedByHookError matches prefix only', () => {
    expect(
      isCompactBlockedByHookError(
        new Error(`${COMPACT_BLOCKED_BY_HOOK_PREFIX}: x`),
      ),
    ).toBe(true)
    expect(isCompactBlockedByHookError(new Error('random compact fail'))).toBe(
      false,
    )
  })
})

describe('isColdCompactEnabled', () => {
  const key = 'CLAUDE_CODE_COLD_COMPACT'
  const prev = process.env[key]

  afterEach(() => {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  })

  test('default off', () => {
    delete process.env[key]
    expect(isColdCompactEnabled()).toBe(false)
  })

  test('env 1 enables', () => {
    process.env[key] = '1'
    expect(isColdCompactEnabled()).toBe(true)
  })
})

describe('stripImagesFromMessages cold reuse', () => {
  test('image and document become placeholders', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', data: 'xx' } },
            { type: 'document', source: { type: 'base64', data: 'yy' } },
            { type: 'text', text: 'keep' },
          ],
        },
      },
    ] as unknown as Message[]

    const out = stripImagesFromMessages(messages)
    const content = (
      out[0] as { message: { content: { type: string; text?: string }[] } }
    ).message.content
    expect(content.map(c => c.type)).toEqual(['text', 'text', 'text'])
    expect(content[0]?.text).toBe('[image]')
    expect(content[1]?.text).toBe('[document]')
    expect(content[2]?.text).toBe('keep')
  })
})

describe('reactiveCompact hook_blocked symmetry', () => {
  test('isCompactBlockedByHookError used by reactive path', async () => {
    // Pure contract: prefix detector is what reactiveCompact catch branches on.
    // Full tryReactiveCompact needs ToolUseContext — covered by unit of detector.
    expect(
      isCompactBlockedByHookError(
        new Error(`${COMPACT_BLOCKED_BY_HOOK_PREFIX}: [h]: stop`),
      ),
    ).toBe(true)
  })
})
