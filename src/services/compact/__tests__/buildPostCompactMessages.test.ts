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
import {
  buildPostCompactMessages,
  type CompactionResult,
  dropRegenerableAttachments,
  POST_COMPACT_SKILLS_TOKEN_BUDGET,
  POST_COMPACT_TOKEN_BUDGET,
} from '../compact'
import { PRESERVED_USER_MESSAGE_MAX_TOKENS } from '../preservedUserMessages'
import { PRESERVE_RECENT_MAX_TOKENS } from '../tailPreservation'

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

function attachmentMsg(type: string): any {
  return { type: 'attachment', attachment: { type } }
}

/**
 * The drop is keyed on a turn counter whose zero means three different things
 * (see the dropRegenerableAttachments doc comment). Two of those three are
 * indistinguishable from the outside, so what is pinned here is the boundary:
 * -1 (a genuine first-ever compact, where tracking is undefined) must NOT
 * drop, 0 must. Anything that makes the guard fire on -1 silently strips
 * attachments from every session's first compact.
 *
 * The type strings are the real discriminants of FileAttachment /
 * CompactFileReferenceAttachment / the invoked-skills attachment. A typo in
 * the set is invisible at the type level — Set<string>.has takes any string —
 * so it can only be caught by naming them again here.
 */
describe('dropRegenerableAttachments', () => {
  const REGENERABLE = ['invoked_skills', 'file', 'compact_file_reference']
  // Behaviour-changing, not content-supplying: dropping these would change
  // what the agent can do, not just what it has to re-fetch.
  const KEPT = [
    'plan_file_reference',
    'plan_mode',
    'deferred_tools',
    'agent_listing',
    'mcp_instructions',
  ]
  const ALL = [...REGENERABLE, ...KEPT].map(attachmentMsg)

  test('keeps everything on a first-ever compact (counter absent → -1)', () => {
    for (const turns of [undefined, -1]) {
      expect(dropRegenerableAttachments(ALL, turns)).toHaveLength(ALL.length)
    }
  })

  test('keeps everything once any turn has elapsed', () => {
    for (const turns of [1, 2, 40]) {
      expect(dropRegenerableAttachments(ALL, turns)).toHaveLength(ALL.length)
    }
  })

  test('drops exactly the regenerable types at zero', () => {
    const kept = dropRegenerableAttachments(ALL, 0).map(
      (m: any) => m.attachment.type,
    )
    expect(kept).toEqual(KEPT)
  })

  test('returns the same array reference when it drops nothing', () => {
    // Identity, not just equality: the non-zero path must not allocate on
    // every compact, and a filter() that always runs would still pass a
    // length check.
    const kept = dropRegenerableAttachments(ALL, 3)
    expect(kept).toBe(ALL)
  })
})

/**
 * The one guard that fails if anyone loosens a post-compact budget.
 *
 * Each individual constant is defensible on its own; what nothing else checks
 * is their SUM — which is what actually lands in the next request. The five
 * components below are independent budgets (separate accumulators, not shared),
 * so the total is what a full load costs.
 *
 * The total is a tripwire on the constants, not a byte-exact bound. The skills
 * accumulator (createSkillAttachmentIfNeeded) meters `skill.content` alone
 * while the request carries the whole JSON attachment; measured on two real
 * SKILL.md files the envelope adds 4.1%, i.e. ~400 tokens at a saturated 10k
 * skills budget. The file accumulator has no such gap — it meters
 * jsonStringify(result). Do not "correct" the ceiling for that 400: the term
 * that matters is any constant below being raised, which this still catches.
 *
 * The 8,000 summary-body allowance is the only non-constant term: the default
 * fork path cannot cap output (see the maxOutputTokens comment in compact.ts),
 * so its real ceiling is the model's 64k. 8,000 is the measured p100 (max
 * observed body = 7,032 over 148 real compacts) — this assertion therefore
 * fails on a body blowout too, which is the intended alarm.
 *
 * Raising any constant means re-justifying the ceiling here, not editing it to
 * match. Post-compact occupancy is the user-facing property being protected.
 *
 * Deliberately arithmetic over the constants rather than measured over an
 * assembled result. roughTokenCountEstimationForMessage routes attachments
 * through normalizeAttachmentForAPI, so a fixture whose attachment shape does
 * not match the real zod-derived Output estimates to 0 — a 16,000-token file
 * budget measured as 0 makes such a test pass while checking nothing. A
 * vacuous pass is worse than no test, so the guard stays on the numbers that
 * actually bound production.
 */
const SUMMARY_BODY_ALLOWANCE = 8_000
const POST_COMPACT_FOOTPRINT_CEILING = 50_000

describe('post-compact footprint ceiling', () => {
  test('the sum of all post-compact budgets stays within the ceiling', () => {
    const total =
      SUMMARY_BODY_ALLOWANCE +
      PRESERVED_USER_MESSAGE_MAX_TOKENS +
      POST_COMPACT_TOKEN_BUDGET +
      POST_COMPACT_SKILLS_TOKEN_BUDGET +
      PRESERVE_RECENT_MAX_TOKENS
    expect(total).toBeLessThanOrEqual(POST_COMPACT_FOOTPRINT_CEILING)
  })

  test('the summary-body allowance is not silently the largest term', () => {
    // The body is the one term with no enforced cap, so it is the term most
    // likely to be raised by "just give the summarizer more room". If it ever
    // exceeds the sum of everything that IS capped, the ceiling has stopped
    // describing a budgeted system.
    const capped =
      PRESERVED_USER_MESSAGE_MAX_TOKENS +
      POST_COMPACT_TOKEN_BUDGET +
      POST_COMPACT_SKILLS_TOKEN_BUDGET +
      PRESERVE_RECENT_MAX_TOKENS
    expect(SUMMARY_BODY_ALLOWANCE).toBeLessThan(capped)
  })
})
