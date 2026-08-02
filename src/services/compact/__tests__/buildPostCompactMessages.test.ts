/**
 * Regression: preserved tail messages must not carry pre-compact API usage.
 *
 * tokenCountWithEstimation anchors on the last usage-bearing assistant
 * message. A preserved assistant's usage describes the PRE-compact context
 * (≈ the over-threshold count that triggered compaction) — if it survived
 * into the post-compact chain, the next turn's auto-compact check and the
 * status bar would both read the stale count and immediately retrigger.
 */
import { describe, expect, test } from 'bun:test'
import { tokenCountWithEstimation } from '../../../utils/tokens'
import { buildPostCompactMessages, type CompactionResult } from '../compact'

const STALE_USAGE = {
  input_tokens: 180_000,
  output_tokens: 500,
  cache_creation_input_tokens: 10_000,
  cache_read_input_tokens: 5_000,
}

function boundary(): any {
  return { type: 'system', subtype: 'compact_boundary', uuid: 'b-1' }
}

function summaryMsg(): any {
  return {
    type: 'user',
    uuid: 's-1',
    isCompactSummary: true,
    message: { role: 'user', content: 'summary text' },
  }
}

function keptAssistant(): any {
  return {
    type: 'assistant',
    uuid: 'k-1',
    message: {
      id: 'msg_k1',
      role: 'assistant',
      content: [{ type: 'text', text: 'kept assistant reply' }],
      usage: STALE_USAGE,
    },
  }
}

function keptUserWithToolUseResult(): any {
  return {
    type: 'user',
    uuid: 'k-2',
    toolUseResult: { stdout: 'huge payload'.repeat(100) },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'result' }],
    },
  }
}

function makeResult(messagesToKeep: any[]): CompactionResult {
  return {
    boundaryMarker: boundary(),
    summaryMessages: [summaryMsg()],
    messagesToKeep,
    attachments: [],
    hookResults: [],
  }
}

describe('buildPostCompactMessages', () => {
  test('orders boundary → summary → kept → attachments → hookResults', () => {
    const result = buildPostCompactMessages(
      makeResult([keptAssistant(), keptUserWithToolUseResult()]),
    )
    expect(result.map(m => m.type)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ])
  })

  test('strips pre-compact usage from preserved assistant messages', () => {
    const result = buildPostCompactMessages(makeResult([keptAssistant()]))
    const kept = result.find(m => (m as any).uuid === 'k-1') as any
    expect(kept.message.usage).toBeUndefined()
  })

  test('strips UI-only toolUseResult payloads from preserved user messages', () => {
    const result = buildPostCompactMessages(
      makeResult([keptUserWithToolUseResult()]),
    )
    const kept = result.find(m => (m as any).uuid === 'k-2') as any
    expect('toolUseResult' in kept).toBe(false)
  })

  test('post-compact tokenCountWithEstimation does not reflect pre-compact usage', () => {
    const result = buildPostCompactMessages(makeResult([keptAssistant()]))
    const count = tokenCountWithEstimation(result)
    // Must be a small rough estimate over boundary+summary+kept, nowhere
    // near the stale ~195K pre-compact count.
    expect(count).toBeLessThan(1_000)
  })

  test('untouched when messagesToKeep is absent', () => {
    const result = buildPostCompactMessages(makeResult([]))
    expect(result).toHaveLength(2)
  })
})
