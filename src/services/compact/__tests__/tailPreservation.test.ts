import { afterEach, describe, expect, test } from 'bun:test'
import {
  PRESERVE_RECENT_MAX_TOKENS,
  PRESERVE_RECENT_MIN_TOKENS,
  preserveRecentBudget,
  selectPreservedTail,
  TAIL_DEFAULT_MAX_ROUNDS,
  tailMaxRounds,
} from '../tailPreservation'

/** Deterministic estimator: chars/4 summed over message string contents. */
const estimateRound = (round: readonly any[]): number =>
  round.reduce(
    (total, m) =>
      total +
      Math.ceil(
        String(typeof m.message?.content === 'string' ? m.message.content : '')
          .length / 4,
      ),
    0,
  )

const ENV_KEYS = [
  'CLAUDE_CODE_COMPACT_TAIL_ROUNDS',
  'CLAUDE_CODE_COMPACT_PRESERVE_RECENT_TOKENS',
] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

/** One API round: a single assistant message with ~chars/4 tokens of text. */
function makeRound(id: string, chars: number): any[] {
  return [
    {
      type: 'assistant',
      message: { id, role: 'assistant', content: 'a'.repeat(chars) },
    },
  ]
}

function makeConversation(rounds: Array<[string, number]>): any[] {
  return rounds.flatMap(([id, chars]) => makeRound(id, chars))
}

describe('tailMaxRounds', () => {
  test('defaults to 2', () => {
    expect(tailMaxRounds()).toBe(TAIL_DEFAULT_MAX_ROUNDS)
  })

  test('env override, including 0 = disabled', () => {
    process.env.CLAUDE_CODE_COMPACT_TAIL_ROUNDS = '5'
    expect(tailMaxRounds()).toBe(5)
    process.env.CLAUDE_CODE_COMPACT_TAIL_ROUNDS = '0'
    expect(tailMaxRounds()).toBe(0)
  })

  test('ignores garbage env values', () => {
    process.env.CLAUDE_CODE_COMPACT_TAIL_ROUNDS = 'nope'
    expect(tailMaxRounds()).toBe(TAIL_DEFAULT_MAX_ROUNDS)
  })
})

describe('preserveRecentBudget', () => {
  test('clamps 25% of the effective window to [2k, 8k]', () => {
    expect(preserveRecentBudget(4_000)).toBe(PRESERVE_RECENT_MIN_TOKENS)
    expect(preserveRecentBudget(16_000)).toBe(4_000)
    expect(preserveRecentBudget(1_000_000)).toBe(PRESERVE_RECENT_MAX_TOKENS)
  })

  test('env override wins outright', () => {
    process.env.CLAUDE_CODE_COMPACT_PRESERVE_RECENT_TOKENS = '12345'
    expect(preserveRecentBudget(1_000_000)).toBe(12_345)
  })
})

describe('selectPreservedTail', () => {
  test('packs newest rounds greedily within the budget', () => {
    // 3 rounds of ~250 tokens each (1000 chars / 4)
    const messages = makeConversation([
      ['r1', 1000],
      ['r2', 1000],
      ['r3', 1000],
    ])
    const { head, tail } = selectPreservedTail(messages, 500, 10, estimateRound)
    expect(head).toHaveLength(1)
    expect(tail).toHaveLength(2)
    expect((tail[0] as any).message.id).toBe('r2')
  })

  test('respects the rounds cap even with budget to spare', () => {
    const messages = makeConversation([
      ['r1', 400],
      ['r2', 400],
      ['r3', 400],
    ])
    const { head, tail } = selectPreservedTail(
      messages,
      100_000,
      2,
      estimateRound,
    )
    expect(head).toHaveLength(1)
    expect(tail).toHaveLength(2)
    expect((tail[0] as any).message.id).toBe('r2')
  })

  test('returns an empty tail when the newest round exceeds the budget', () => {
    const messages = makeConversation([
      ['r1', 400],
      ['r2', 40_000], // ~10k tokens, over any 8k budget
    ])
    const { head, tail } = selectPreservedTail(
      messages,
      8_000,
      2,
      estimateRound,
    )
    expect(tail).toHaveLength(0)
    expect(head).toHaveLength(2)
  })

  test('returns an empty tail when everything fits (nothing to summarize)', () => {
    const messages = makeConversation([
      ['r1', 400],
      ['r2', 400],
    ])
    const { head, tail } = selectPreservedTail(
      messages,
      100_000,
      5,
      estimateRound,
    )
    expect(tail).toHaveLength(0)
    expect(head).toHaveLength(2)
  })

  test('returns an empty tail when disabled via maxRounds = 0', () => {
    const messages = makeConversation([
      ['r1', 400],
      ['r2', 400],
      ['r3', 400],
    ])
    const { head, tail } = selectPreservedTail(
      messages,
      100_000,
      0,
      estimateRound,
    )
    expect(tail).toHaveLength(0)
    expect(head).toHaveLength(3)
  })

  test('keeps same-id streaming chunks together as one round', () => {
    const chunk = (id: string, chars: number) => ({
      type: 'assistant',
      message: { id, role: 'assistant', content: 'a'.repeat(chars) },
    })
    const messages: any[] = [
      chunk('r1', 400),
      chunk('r2', 200),
      chunk('r2', 200), // same id → same round
    ]
    const { head, tail } = selectPreservedTail(
      messages,
      100_000,
      1,
      estimateRound,
    )
    expect(head).toHaveLength(1)
    expect(tail).toHaveLength(2)
  })
})
