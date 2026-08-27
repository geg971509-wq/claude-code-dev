import { describe, expect, test } from 'bun:test'
import {
  buildPeerMessageEnvelope,
  buildPeerReceipt,
  buildUdsPeerUserMessage,
  parsePeerMessageEnvelope,
  parsePeerReceipt,
} from '../peerMessageEnvelope.js'

describe('peer message envelope', () => {
  test('round-trips content while escaping sender attributes', () => {
    const wrapped = buildPeerMessageEnvelope('hello\nworld', {
      from: 'uds:/tmp/a"b.sock',
      name: '<sender>',
      msgId: 'message-id',
      fromMode: 'prompting',
    })

    expect(wrapped).toContain('from="uds:/tmp/a&quot;b.sock"')
    expect(wrapped).toContain('from-name="&lt;sender&gt;"')
    expect(parsePeerMessageEnvelope(wrapped)).toEqual({
      content: 'hello\nworld',
      from: 'uds:/tmp/a"b.sock',
      name: '<sender>',
      msgId: 'message-id',
      fromMode: 'prompting',
    })
  })

  test('builds the formal UDS user envelope', () => {
    expect(
      buildUdsPeerUserMessage({
        content: 'work on this',
        from: 'uds:/tmp/sender.sock',
        fromMode: 'bypass',
        msgId: 'm1',
        sessionId: 'target-session',
        priority: 'later',
        attachments: [
          {
            path: '/tmp/spool/a.txt',
            file_name: 'a.txt',
            file_size: 3,
            sha256: 'a'.repeat(64),
            media_type: 'text/plain',
          },
        ],
      }),
    ).toEqual({
      type: 'user',
      uuid: 'm1',
      session_id: 'target-session',
      message: { role: 'user', content: 'work on this' },
      priority: 'later',
      file_attachments: [
        {
          path: '/tmp/spool/a.txt',
          file_name: 'a.txt',
          file_size: 3,
          sha256: 'a'.repeat(64),
          media_type: 'text/plain',
        },
      ],
      from: 'uds:/tmp/sender.sock',
      msg_id: 'm1',
      fromMode: 'bypass',
    })
  })

  test('round-trips compact receipt tags used by bridge ingress', () => {
    const content = buildPeerReceipt({
      msgId: 'm1',
      status: 'delivered',
      from: 'bridge:receiver',
      reason: 'approved',
    })
    expect(parsePeerReceipt(content)).toEqual({
      msgId: 'm1',
      status: 'delivered',
      from: 'bridge:receiver',
      reason: 'approved',
    })
    expect(parsePeerReceipt('ordinary input')).toBeUndefined()
  })
})
