import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../../../entrypoints/agentSdkTypes.js'
import { SDKCompactBoundaryMessageSchema } from '../../../entrypoints/sdk/coreSchemas.js'
import { convertSDKMessage } from '../../../remote/sdkMessageAdapter.js'
import type { CompactMetadata, Message } from '../../../types/message.js'
import { getMaxCumulativeDroppedTokens } from '../compact.js'
import {
  fromSDKCompactMetadata,
  toInternalMessages,
  toSDKCompactMetadata,
  toSDKMessages,
} from '../../../utils/messages/mappers.js'

const metadata: CompactMetadata = {
  trigger: 'auto',
  preTokens: 120_000,
  postTokens: 24_000,
  cumulativeDroppedTokens: 196_000,
  durationMs: 1_250,
  userContext: 'keep the release checklist',
  messagesSummarized: 42,
  precomputed: true,
  preCompactDiscoveredTools: ['Deploy', 'Inspect'],
  preservedSegment: {
    headUuid: '00000000-0000-4000-8000-000000000001',
    anchorUuid: '00000000-0000-4000-8000-000000000002',
    tailUuid: '00000000-0000-4000-8000-000000000003',
  },
  future_metadata: 'preserved',
}

describe('compact boundary metadata', () => {
  test('round-trips all known fields and preserves future SDK fields', () => {
    const sdk = toSDKCompactMetadata(metadata)

    expect(sdk).toEqual({
      trigger: 'auto',
      pre_tokens: 120_000,
      post_tokens: 24_000,
      cumulative_dropped_tokens: 196_000,
      duration_ms: 1_250,
      user_context: 'keep the release checklist',
      messages_summarized: 42,
      precomputed: true,
      pre_compact_discovered_tools: ['Deploy', 'Inspect'],
      preserved_segment: {
        head_uuid: '00000000-0000-4000-8000-000000000001',
        anchor_uuid: '00000000-0000-4000-8000-000000000002',
        tail_uuid: '00000000-0000-4000-8000-000000000003',
      },
      future_metadata: 'preserved',
    })
    expect(fromSDKCompactMetadata(sdk)).toEqual(metadata)
  })

  test('accepts the old minimal metadata shape', () => {
    expect(
      fromSDKCompactMetadata({ trigger: 'manual', pre_tokens: 10 }),
    ).toEqual({ trigger: 'manual', preTokens: 10 })
    expect(
      SDKCompactBoundaryMessageSchema().safeParse({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {},
        uuid: '00000000-0000-4000-8000-000000000004',
        session_id: 'session-1',
      }).success,
    ).toBe(true)
  })

  test('does not lose inbound compact boundaries behind the user branch', () => {
    const sdkMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: toSDKCompactMetadata(metadata),
      uuid: '00000000-0000-4000-8000-000000000004',
      session_id: 'session-1',
    } as unknown as SDKMessage
    const [message] = toInternalMessages([sdkMessage])

    expect(message?.type).toBe('system')
    expect(message?.subtype).toBe('compact_boundary')
    expect(message?.compactMetadata).toEqual(metadata)
    expect(convertSDKMessage(sdkMessage)).toEqual({
      type: 'message',
      message: expect.objectContaining({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: metadata,
      }),
    })
  })

  test('emits schema-valid SDK compact boundary messages', () => {
    const [sdkMessage] = toSDKMessages([
      {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: metadata,
        uuid: '00000000-0000-4000-8000-000000000004',
      } as Message,
    ])

    expect(
      SDKCompactBoundaryMessageSchema().safeParse(sdkMessage).success,
    ).toBe(true)
  })

  test('uses the maximum prior cumulative count for non-monotonic boundaries', () => {
    const boundaries = [120, 80, 100].map((cumulativeDroppedTokens, index) => ({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { cumulativeDroppedTokens },
      uuid: `boundary-${index}`,
    })) as Message[]

    expect(getMaxCumulativeDroppedTokens(boundaries)).toBe(120)
  })
})
