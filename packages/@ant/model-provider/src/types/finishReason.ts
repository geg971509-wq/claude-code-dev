/**
 * Normalized finish-reason signal indicating why a generation stopped.
 *
 * Provider-native values are mapped here; raw wire strings stay available
 * via {@link NormalizedFinishReason.rawFinishReason}.
 *
 * - `completed`: normal completion (OpenAI `stop`, Anthropic `end_turn`)
 * - `tool_calls`: paused for tool dispatch
 * - `truncated`: token budget exhausted
 * - `filtered`: safety / content filter
 * - `paused`: Anthropic `pause_turn`
 * - `other`: recognized non-null reason outside the categories above
 */
export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other'

export type NormalizedFinishReason = {
  finishReason: FinishReason | null
  rawFinishReason: string | null
}

/**
 * Map a normalized finish reason to Anthropic `stop_reason`.
 * Tool-call presence wins when the provider only emits a generic stop.
 */
export function finishReasonToAnthropicStopReason(
  finishReason: FinishReason | null | undefined,
  hasToolCalls = false,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  if (finishReason === 'truncated') return 'max_tokens'
  if (finishReason === 'tool_calls' || hasToolCalls) return 'tool_use'
  return 'end_turn'
}

/** OpenAI Chat Completions `finish_reason`. */
export function normalizeOpenAIFinishReason(
  raw: string | null | undefined,
): NormalizedFinishReason {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null }
  }
  switch (raw) {
    case 'stop':
      return { finishReason: 'completed', rawFinishReason: raw }
    case 'tool_calls':
    case 'function_call':
      return { finishReason: 'tool_calls', rawFinishReason: raw }
    case 'length':
      return { finishReason: 'truncated', rawFinishReason: raw }
    case 'content_filter':
      return { finishReason: 'filtered', rawFinishReason: raw }
    default:
      return { finishReason: 'other', rawFinishReason: raw }
  }
}

/** Anthropic Messages `stop_reason`. */
export function normalizeAnthropicStopReason(
  raw: string | null | undefined,
): NormalizedFinishReason {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null }
  }
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return { finishReason: 'completed', rawFinishReason: raw }
    case 'max_tokens':
      return { finishReason: 'truncated', rawFinishReason: raw }
    case 'tool_use':
      return { finishReason: 'tool_calls', rawFinishReason: raw }
    case 'pause_turn':
      return { finishReason: 'paused', rawFinishReason: raw }
    case 'refusal':
      return { finishReason: 'filtered', rawFinishReason: raw }
    default:
      return { finishReason: 'other', rawFinishReason: raw }
  }
}

/** Gemini / Google GenAI `finishReason`. */
export function normalizeGeminiFinishReason(
  raw: unknown,
): NormalizedFinishReason {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null }
  }
  let rawString: string
  if (typeof raw === 'string') {
    rawString = raw.toUpperCase()
  } else if (
    typeof raw === 'number' ||
    typeof raw === 'bigint' ||
    typeof raw === 'boolean'
  ) {
    rawString = String(raw).toUpperCase()
  } else {
    return { finishReason: null, rawFinishReason: null }
  }
  if (rawString === 'FINISH_REASON_UNSPECIFIED' || rawString === '') {
    return { finishReason: null, rawFinishReason: null }
  }
  switch (rawString) {
    case 'STOP':
      return { finishReason: 'completed', rawFinishReason: rawString }
    case 'MAX_TOKENS':
      return { finishReason: 'truncated', rawFinishReason: rawString }
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return { finishReason: 'filtered', rawFinishReason: rawString }
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
    case 'LANGUAGE':
      return { finishReason: 'other', rawFinishReason: rawString }
    default:
      return { finishReason: 'other', rawFinishReason: rawString }
  }
}

/** OpenAI Responses API status + incomplete_details.reason. */
export function normalizeResponsesFinishReason(
  status: string | null | undefined,
  incompleteReason?: string | null,
): NormalizedFinishReason {
  if (status === null || status === undefined) {
    return { finishReason: null, rawFinishReason: null }
  }
  if (status === 'completed') {
    return { finishReason: 'completed', rawFinishReason: 'completed' }
  }
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') {
      return {
        finishReason: 'truncated',
        rawFinishReason: 'max_output_tokens',
      }
    }
    if (incompleteReason === 'content_filter') {
      return {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      }
    }
    // Bare incomplete (no reason) historically mapped to max_tokens in
    // this codebase — treat as truncated rather than generic other.
    return {
      finishReason: 'truncated',
      rawFinishReason: incompleteReason ?? 'incomplete',
    }
  }
  if (status === 'failed') {
    return { finishReason: 'other', rawFinishReason: 'failed' }
  }
  return { finishReason: null, rawFinishReason: null }
}
