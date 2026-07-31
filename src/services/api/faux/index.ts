/**
 * Faux provider — a scripted, offline LLM for evals and end-to-end tests.
 *
 * Deliberately NOT a member of the `APIProvider` union: that union feeds
 * `ModelConfig = Record<APIProvider, ModelName>`, so joining it would force 12
 * config-literal edits plus ~60 behavioural sites (betas, thinking, effort,
 * cost, auth, /status) that have no exhaustiveness check and would each fall
 * through to first-party behaviour silently. A faux provider needs none of
 * that — it is a stream seam, not a model family — so it is gated on
 * `CLAUDE_CODE_USE_FAUX` at the `queryModel` dispatch instead.
 *
 * Script format (`CLAUDE_CODE_FAUX_SCRIPT=/path/to/script.json`):
 *
 *   { "turns": [
 *       { "text": "Reading it.",
 *         "toolUses": [{ "name": "Read", "input": { "file_path": "/tmp/a" } }] },
 *       { "text": "Done." }
 *   ] }
 *
 * A bare top-level array is accepted as shorthand for `{ turns: [...] }`.
 */
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaContentBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import type { Options } from '../claude.js'
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'
import { logForDebugging } from '../../../utils/debug.js'

export type FauxToolUse = {
  name: string
  input: Record<string, unknown>
  /** Omit for a deterministic `toolu_faux_<turn>_<index>` id. */
  id?: string
}

export type FauxTurn = {
  text?: string
  thinking?: string
  toolUses?: FauxToolUse[]
  /** Defaults to `tool_use` when `toolUses` is non-empty, else `end_turn`. */
  stopReason?: string
}

export type FauxScript = { turns: FauxTurn[] }

/** Text is emitted in chunks this wide so consumers see real incremental deltas. */
const CHUNK_SIZE = 12

/**
 * Parse a faux script. Throws with a caller-facing message on malformed input —
 * `queryModelFaux` converts that into an API error message.
 */
export function parseFauxScript(raw: string): FauxScript {
  const parsed: unknown = JSON.parse(raw)
  const turns = Array.isArray(parsed)
    ? parsed
    : (parsed as { turns?: unknown } | null)?.turns
  if (!Array.isArray(turns)) {
    throw new Error('expected an array of turns, or { "turns": [...] }')
  }
  turns.forEach((turn, i) => {
    if (typeof turn !== 'object' || turn === null) {
      throw new Error(`turn ${i} is not an object`)
    }
    const { text, thinking, toolUses } = turn as FauxTurn
    if (text !== undefined && typeof text !== 'string') {
      throw new Error(`turn ${i}: "text" must be a string`)
    }
    if (thinking !== undefined && typeof thinking !== 'string') {
      throw new Error(`turn ${i}: "thinking" must be a string`)
    }
    if (toolUses !== undefined) {
      if (!Array.isArray(toolUses)) {
        throw new Error(`turn ${i}: "toolUses" must be an array`)
      }
      toolUses.forEach((use, j) => {
        if (typeof use?.name !== 'string') {
          throw new Error(`turn ${i}, toolUse ${j}: "name" must be a string`)
        }
        if (typeof use?.input !== 'object' || use.input === null) {
          throw new Error(`turn ${i}, toolUse ${j}: "input" must be an object`)
        }
      })
    }
  })
  return { turns: turns as FauxTurn[] }
}

/**
 * Which turn to replay, derived from the transcript rather than a counter:
 * a module-level counter would desync across parallel subagents and would not
 * reproduce on resume, whereas message count is a pure function of the input.
 * Transcript compaction can replace earlier assistant turns with a summary, so
 * scripts must stay shorter than the compaction window.
 */
export function fauxTurnIndex(messages: Message[]): number {
  return messages.filter(
    m => m.type === 'assistant' && !(m as AssistantMessage).isApiErrorMessage,
  ).length
}

/** Deterministic stand-in for real tokenization — never billed, only reported. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function* chunkText(text: string): Generator<string> {
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    yield text.slice(i, i + CHUNK_SIZE)
  }
}

/** Turn used when the script has fewer turns than the conversation has rounds. */
const EXHAUSTED_TURN: FauxTurn = {
  text: '[faux] script exhausted — no turn defined for this round.',
  stopReason: 'end_turn',
}

export async function* queryModelFaux(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  const scriptPath = process.env.CLAUDE_CODE_FAUX_SCRIPT
  let script: FauxScript
  try {
    script = scriptPath
      ? parseFauxScript(readFileSync(scriptPath, 'utf8'))
      : { turns: [] }
  } catch (error) {
    yield createAssistantAPIErrorMessage({
      content: `[faux] cannot load CLAUDE_CODE_FAUX_SCRIPT (${scriptPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
    return
  }

  const turnIndex = fauxTurnIndex(messages)
  const turn = script.turns[turnIndex] ?? EXHAUSTED_TURN
  const delayMs = Number(process.env.CLAUDE_CODE_FAUX_DELAY_MS) || 0
  logForDebugging(
    `[Faux] turn ${turnIndex}/${script.turns.length}, tools=${tools.length}, systemPromptBlocks=${
      Array.isArray(systemPrompt) ? systemPrompt.length : 1
    }`,
  )

  const messageId = `msg_faux_${turnIndex}`
  const stopReason =
    turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn')
  const outputText = (turn.thinking ?? '') + (turn.text ?? '')
  const usage = {
    input_tokens: estimateTokens(JSON.stringify(messages)),
    output_tokens: estimateTokens(outputText),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  const partialMessage = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: options.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage,
  } as unknown as BetaMessage

  const events: StreamEvent[] = [
    { type: 'message_start', message: partialMessage, ttftMs: 0 },
  ]
  const blocks: Record<string, unknown>[] = []
  let index = 0

  if (turn.thinking) {
    blocks.push({ type: 'thinking', thinking: turn.thinking, signature: '' })
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
    for (const chunk of chunkText(turn.thinking)) {
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: chunk },
      })
    }
    events.push({ type: 'content_block_stop', index })
    index++
  }

  if (turn.text) {
    blocks.push({ type: 'text', text: turn.text })
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
    for (const chunk of chunkText(turn.text)) {
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: chunk },
      })
    }
    events.push({ type: 'content_block_stop', index })
    index++
  }

  for (const [useIndex, use] of (turn.toolUses ?? []).entries()) {
    const id = use.id ?? `toolu_faux_${turnIndex}_${useIndex}`
    blocks.push({ type: 'tool_use', id, name: use.name, input: use.input })
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name: use.name, input: {} },
    })
    events.push({
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(use.input),
      },
    })
    events.push({ type: 'content_block_stop', index })
    index++
  }

  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  })

  for (const event of events) {
    if (signal.aborted) throw new APIUserAbortError()
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    yield { type: 'stream_event', event } as StreamEvent
  }

  yield {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: `req_faux_${turnIndex}`,
    message: {
      ...partialMessage,
      content: normalizeContentFromAPI(
        blocks as unknown as BetaContentBlock[],
        tools,
        options.agentId,
      ),
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    },
  } as unknown as AssistantMessage

  yield {
    type: 'stream_event',
    event: { type: 'message_stop' },
  } as StreamEvent
}
