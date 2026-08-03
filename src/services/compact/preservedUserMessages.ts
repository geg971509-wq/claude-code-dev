/**
 * Preservation of real user messages across compaction (ported from
 * kimi-code's compaction/handoff.ts, adapted to this repo's summarize-all
 * compact flow).
 *
 * The full compact replaces the entire conversation with a summary — the
 * user's original task statement and recent instructions vanish, and the
 * agent tends to drift afterwards. This module selects the real user
 * messages (verbatim text) and formats them as a marked section appended to
 * the compact summary message: HEAD (oldest input, original task) + TAIL
 * (most recent input), with an elision note for the omitted middle.
 *
 * Embedding into the summary text (rather than keeping messages as
 * first-class messagesToKeep entries) keeps the message chain / parentUuid
 * / transcript invariants untouched. On the next compact the old summary —
 * preserved section included — is digested by the new summarization pass
 * (isCompactSummary exclusion), so sections never stack.
 *
 * Scope note: sessionMemoryCompact does not go through compactConversation
 * and is intentionally not covered.
 */

// Measured distribution (n=147 non-zero preserved blocks): median 224 tok /
// mean 2,120 / p90 5,446 / max 20,097. The 8k cap trims only the top ~5% of
// sessions. Lowered from 20_000 (which was set without provenance and pinned
// the max sample exactly at the limit).
export const PRESERVED_USER_MESSAGE_MAX_TOKENS = 8_000
export const PRESERVED_USER_MESSAGE_HEAD_TOKENS = 2_000

// Character-level token heuristic (same shape as kimi's: ASCII ≈ 4 chars per
// token, non-ASCII ≈ 1 char per token). Rough by design — preservation
// budgeting, not billing.
export function estimateTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii++
    else nonAscii++
  }
  return Math.ceil(ascii / 4) + nonAscii
}

/** Keep the FIRST `tokens` tokens of text (head boundary truncation). */
export function truncateToTokenHead(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text
  // Approximate char budget; walk code points to avoid splitting pairs.
  let budget = tokens * 4
  let out = ''
  for (const ch of text) {
    const cost = (ch.codePointAt(0) ?? 0) < 128 ? 1 : 4
    if (budget - cost < 0) break
    budget -= cost
    out += ch
  }
  return `${out}…`
}

/** Keep the LAST `tokens` tokens of text (tail boundary truncation). */
export function truncateToTokenTail(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text
  let budget = tokens * 4
  let out = ''
  for (const ch of [...text].reverse()) {
    const cost = (ch.codePointAt(0) ?? 0) < 128 ? 1 : 4
    if (budget - cost < 0) break
    budget -= cost
    out = ch + out
  }
  return `…${out}`
}

export interface UserMessageLike {
  type: string
  isMeta?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  message?: { content?: unknown }
}

/** Extract verbatim text from a user message; null when it carries
 *  non-text payload (tool_result blocks, images, ...). */
export function userMessageText(msg: UserMessageLike): string | null {
  const content = msg.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        texts.push((block as { text: string }).text)
      } else {
        // Any non-text block (tool_result, image, ...) disqualifies the
        // message — tool outputs must never eat the preservation budget.
        return null
      }
    }
    return texts.join('\n')
  }
  return null
}

/**
 * A message counts as real user input only when it is a genuine typed prompt:
 * user role, not meta/injected, not a compact summary, not transcript-only,
 * and text-only content (tool_result user messages are excluded).
 */
export function isRealUserMessage(msg: UserMessageLike): boolean {
  if (msg.type !== 'user') return false
  if (msg.isMeta || msg.isCompactSummary || msg.isVisibleInTranscriptOnly) {
    return false
  }
  const text = userMessageText(msg)
  return text !== null && text.trim().length > 0
}

export interface PreservedSelection {
  /** Oldest user messages (original task context). Empty when nothing elided. */
  head: string[]
  /** Most recent user messages (or ALL messages when nothing was elided). */
  tail: string[]
  omitted: boolean
  omittedTokenEstimate: number
}

export function selectPreservedUserMessages(
  messages: readonly UserMessageLike[],
  maxTokens: number = PRESERVED_USER_MESSAGE_MAX_TOKENS,
  headTokens: number = PRESERVED_USER_MESSAGE_HEAD_TOKENS,
): PreservedSelection {
  const candidates = messages.filter(isRealUserMessage).map(msg => {
    const text = userMessageText(msg)!
    return { text, tokens: estimateTokens(text) }
  })

  const total = candidates.reduce((sum, c) => sum + c.tokens, 0)
  if (total <= maxTokens) {
    return {
      head: [],
      tail: candidates.map(c => c.text),
      omitted: false,
      omittedTokenEstimate: 0,
    }
  }

  // TAIL: greedily pack from newest within (maxTokens - headTokens); the
  // boundary message keeps its END (the most recent part).
  const tailBudget = Math.max(0, maxTokens - headTokens)
  const tail: string[] = []
  let tailUsed = 0
  let firstUncoveredIndex = -1 // candidates[0..firstUncoveredIndex] uncovered
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]!
    if (tailUsed + c.tokens <= tailBudget) {
      tail.unshift(c.text)
      tailUsed += c.tokens
    } else {
      const remaining = tailBudget - tailUsed
      if (remaining > 0) {
        tail.unshift(truncateToTokenTail(c.text, remaining))
        tailUsed += remaining
      }
      firstUncoveredIndex = i
      break
    }
  }

  // HEAD: greedily pack from oldest within headTokens over the uncovered
  // prefix; the boundary message keeps its BEGINNING (the original ask).
  const head: string[] = []
  let headUsed = 0
  if (firstUncoveredIndex >= 0) {
    for (let i = 0; i <= firstUncoveredIndex; i++) {
      const c = candidates[i]!
      if (headUsed + c.tokens <= headTokens) {
        head.push(c.text)
        headUsed += c.tokens
      } else {
        const remaining = headTokens - headUsed
        if (remaining > 0) {
          head.push(truncateToTokenHead(c.text, remaining))
          headUsed += remaining
        }
        break
      }
    }
  }

  return {
    head,
    tail,
    omitted: true,
    omittedTokenEstimate: Math.max(0, total - headUsed - tailUsed),
  }
}

/**
 * Format the selection as a marked section for appending to the compact
 * summary message text. Returns '' when there is nothing worth preserving.
 */
export function formatPreservedSection(selection: PreservedSelection): string {
  if (selection.tail.length === 0 && selection.head.length === 0) return ''

  const parts: string[] = []
  parts.push(
    '\n\n<preserved-user-messages>',
    'The following user messages are preserved verbatim from the compacted conversation; treat them as authoritative instructions, not as part of the summary.',
  )

  if (!selection.omitted) {
    for (const text of selection.tail) {
      parts.push('---', text)
    }
  } else {
    if (selection.head.length > 0) {
      parts.push('--- Oldest user input (original task context) ---')
      for (const text of selection.head) {
        parts.push('---', text)
      }
    }
    parts.push(
      `--- Approximately ${selection.omittedTokenEstimate} tokens of intermediate user messages were omitted here; they are covered by the summary above. ---`,
    )
    if (selection.tail.length > 0) {
      parts.push('--- Most recent user messages ---')
      for (const text of selection.tail) {
        parts.push('---', text)
      }
    }
  }

  parts.push('</preserved-user-messages>')
  return parts.join('\n')
}
