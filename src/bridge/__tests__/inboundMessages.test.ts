import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import {
  extractInboundMessageFields,
  type InboundMessageFields,
} from '../inboundMessages.js'

function user(content: string): SDKMessage {
  return {
    type: 'user',
    uuid: '00000000-0000-4000-8000-000000000001',
    message: { role: 'user', content },
  } as unknown as SDKMessage
}

function fields(content: string): InboundMessageFields {
  const result = extractInboundMessageFields(user(content))
  expect(result).toBeDefined()
  return result!
}

describe('extractInboundMessageFields', () => {
  test('keeps ordinary bridge input on the human path', () => {
    expect(fields('hello')).toEqual({
      kind: 'human',
      content: 'hello',
      uuid: '00000000-0000-4000-8000-000000000001',
    })
  })

  test('recognizes a complete cross-session agent envelope', () => {
    expect(
      fields(
        '<cross-session-message from="bridge:sender" from-name="build" msg-id="m1" from-mode="bypass">\nrun checks\n</cross-session-message>',
      ),
    ).toEqual({
      kind: 'peer',
      content: 'run checks',
      uuid: '00000000-0000-4000-8000-000000000001',
      peer: {
        content: 'run checks',
        from: 'bridge:sender',
        name: 'build',
        msgId: 'm1',
        fromMode: 'bypass',
      },
    })
  })

  test('recognizes peer receipts without injecting them as prompts', () => {
    expect(
      fields(
        '<peer-message-status msg-id="m1" status="delivered" from="cloud:receiver" />',
      ),
    ).toEqual({
      kind: 'receipt',
      uuid: '00000000-0000-4000-8000-000000000001',
      receipt: {
        msgId: 'm1',
        status: 'delivered',
        from: 'cloud:receiver',
        reason: undefined,
      },
    })
  })

  test('treats malformed protocol-looking text as ordinary input', () => {
    expect(
      fields('<cross-session-message>hello</cross-session-message>'),
    ).toEqual({
      kind: 'human',
      content: '<cross-session-message>hello</cross-session-message>',
      uuid: '00000000-0000-4000-8000-000000000001',
    })
  })
})
