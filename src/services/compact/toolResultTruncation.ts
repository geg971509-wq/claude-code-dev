import type { Message } from '../../types/message.js'

export const COMPACT_TOOL_RESULT_MAX_CHARS = 2_000

/**
 * Truncate long tool_result text before sending it to the summarizer.
 * Applied ONLY on the streaming fallback path — the forked cache-sharing
 * path needs a byte-identical message prefix to reuse the main
 * conversation's prompt cache, and truncation there would turn cheap
 * cache_read into full cache_creation. On the fallback path (3P providers,
 * cache-sharing disabled/failed) there is no cache to reuse, so truncation
 * is a pure win and also lowers the chance the compact request itself hits
 * prompt-too-long.
 *
 * Keeps head AND tail with an omission marker between them. The verdict of a
 * tool run lives at the END of its output (test pass counts, exit codes, the
 * failing assertion) while the head is command echo — head-only truncation
 * threw away exactly the part the summarizer needs. Total budget unchanged.
 * Messages with nothing to truncate are returned as-is.
 *
 * Lives in its own module (like grouping.ts) so tests don't have to import
 * the whole compact.ts dependency graph.
 */
export function truncateToolResultsForCompaction(
  messages: Message[],
  maxChars: number = COMPACT_TOOL_RESULT_MAX_CHARS,
): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') {
      return message
    }
    const content = message.message!.content
    if (!Array.isArray(content)) {
      return message
    }

    let changed = false
    const newContent = content.map(block => {
      if (block.type !== 'tool_result' || block.content === undefined) {
        return block
      }
      const truncated = truncateToolResultContent(block.content, maxChars)
      if (truncated === block.content) {
        return block
      }
      changed = true
      return { ...block, content: truncated } as typeof block
    })
    if (!changed) {
      return message
    }
    return {
      ...message,
      message: {
        ...message.message,
        content: newContent,
      },
    } as typeof message
  })
}

function truncateToolResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  // At maxChars <= 1, the calculation below would produce tailChars=0 and
  // slice(-0) returns the whole string — truncation inverts. Unreachable via
  // the single caller (default 2000), but guard it anyway.
  if (maxChars < 2) {
    return text.slice(0, Math.max(0, maxChars))
  }
  const headChars = Math.ceil(maxChars / 2)
  const tailChars = maxChars - headChars
  const omitted = text.length - maxChars
  const marker = `\n[Tool output truncated for compaction: omitted ${omitted} chars]\n`
  // The marker costs ~58 chars, so replacing a smaller omission with it GROWS
  // the payload — at the default maxChars that inflated every result in
  // (2_000, 2_058]. A function named truncate must never return more than it
  // was given, so give up when the marker would not pay for itself.
  if (marker.length >= omitted) {
    return text
  }
  // Explicit end index, not slice(-tailChars): the guard above prevents
  // tailChars=0, but the explicit form documents the intent.
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`
}

function truncateToolResultContent(
  content: unknown,
  maxChars: number,
): unknown {
  if (typeof content === 'string') {
    return truncateToolResultText(content, maxChars)
  }
  if (!Array.isArray(content)) {
    return content
  }
  let changed = false
  const next = content.map(item => {
    if (
      item?.type === 'text' &&
      typeof item.text === 'string' &&
      item.text.length > maxChars
    ) {
      changed = true
      return { ...item, text: truncateToolResultText(item.text, maxChars) }
    }
    return item
  })
  return changed ? next : content
}
