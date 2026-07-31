/**
 * Sub-agent summary quality gate (ported from kimi-code's subagent-host.ts).
 *
 * When a sub-agent's final assistant text is suspiciously short ("Done."),
 * the parent agent receives a useless handoff. The gate gives the agent one
 * extra, tool-free turn asking it to expand the summary; if it is still
 * short after that, accept it as-is rather than retrying indefinitely.
 *
 * NOTE: this module deliberately lives inside builtin-tools (not src/) and
 * stays dependency-free — the packages→src boundary ratchet
 * (scripts/boundaries-baseline.json) forbids new reverse imports. The prompt
 * text mirrors kimi-code's summary-continuation.md.
 */

/** A final summary shorter than this triggers one expansion turn. */
export const SUMMARY_MIN_LENGTH = 200

/** Hard cap on expansion turns — prevents unbounded continuation loops. */
export const SUMMARY_CONTINUATION_ATTEMPTS = 1

export const SUMMARY_CONTINUATION_PROMPT = `Your previous response was too brief. Please provide a more comprehensive summary that includes:

1. Specific technical details and implementations
2. Detailed findings and analysis
3. All important information that the parent agent should know`

interface AssistantMessageLike {
  type: string
  message?: { content?: unknown }
}

/**
 * The text of the most recent non-empty assistant message, walking backwards.
 * Tool-use-only trailing messages are skipped; returns '' when there is no
 * assistant text at all.
 */
export function lastAssistantText(
  messages: readonly AssistantMessageLike[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map(block => block.text)
      .join('')
      .trim()
    if (text.length > 0) return text
  }
  return ''
}
