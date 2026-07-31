/**
 * Tool-call loop detection with graduated intervention.
 *
 * Ported from kimi-code's tool-dedup.ts (packages/agent-core), simplified:
 * only the cross-step consecutive-streak detection is kept — the same-step
 * dedup Deferred machinery was dropped because real-world loops are almost
 * always cross-step streaks, and the dedup path buys little for its async
 * ordering complexity.
 *
 * Known limitation (shared with the kimi original): alternating period≥2
 * loops (A→B→A→B) reset each other's streak and are never detected.
 *
 * This module is intentionally pure logic with no imports so it stays
 * trivially testable; the query.ts integration layer feeds it tool results
 * and applies the reminders it produces.
 */

// Escalation thresholds (consecutive identical calls).
export const REPEAT_REMINDER_1_START = 3
export const REPEAT_REMINDER_2_START = 5
export const REPEAT_REMINDER_3_START = 8
export const REPEAT_FORCE_STOP_STREAK = 12

// Cap the canonical-args portion of the key: FileWrite/Read inputs can be
// several KB to MB, and recursively serializing them on every tool call is
// hot-path cost for no discriminative gain beyond the first few KB.
const INPUT_KEY_MAX_CHARS = 4096

export type ToolLoopLevel = 'none' | 'r1' | 'r2' | 'r3' | 'stop'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJsonValue(value[key])
  }
  return out
}

/** Stable serialization: recursively sorted keys, so {a:1,b:2} === {b:2,a:1}. */
export function stableStringify(value: unknown): string {
  try {
    const json = JSON.stringify(sortJsonValue(value))
    return json ?? String(value)
  } catch {
    return String(value)
  }
}

export function toolCallKey(toolName: string, input: unknown): string {
  let argsKey = stableStringify(input)
  if (argsKey.length > INPUT_KEY_MAX_CHARS) {
    argsKey = argsKey.slice(0, INPUT_KEY_MAX_CHARS)
  }
  return `${toolName} ${argsKey}`
}

export function levelForStreak(streak: number): ToolLoopLevel {
  if (streak >= REPEAT_FORCE_STOP_STREAK) return 'stop'
  if (streak >= REPEAT_REMINDER_3_START) return 'r3'
  if (streak >= REPEAT_REMINDER_2_START) return 'r2'
  if (streak >= REPEAT_REMINDER_1_START) return 'r1'
  return 'none'
}

// Reminder texts are static (no interpolated streak counts) so that a
// repeated reminder at the same level is byte-identical — this keeps prompt
// cache churn to the single suffix position instead of varying every turn.
// Texts follow kimi-code's tool-dedup.ts originals.
const REMINDER_R1 =
  'The same tool call has been repeated several times in a row. Before making your next call, write one sentence stating what new information you expect it to produce. Then act on that sentence: if it names something this result does not already give you, choose the action that best provides it; otherwise, continue with the evidence you already have.'

const REMINDER_R2 =
  'The same tool call has now been issued many times in a row. Choose exactly one of the following and state your choice before acting: (1) Falsification check: run the cheapest test that could conclusively disprove your current approach, if such a test exists. (2) Missing input: tell the user precisely what information or decision you need to proceed, and ask for it. (3) Conclude: deliver your best result based on the evidence already gathered, listing anything that remains uncertain.'

const REMINDER_R3 =
  'Write your final response now, without any further tool calls. Cover: the current blocker, each approach you have tried and what it established, and the specific information or decision you need from the user to unblock progress. Text only.'

/** Reminder text for a level; 'stop' reuses the r3 text. 'none' → null. */
export function reminderForLevel(level: ToolLoopLevel): string | null {
  switch (level) {
    case 'r1':
      return REMINDER_R1
    case 'r2':
      return REMINDER_R2
    case 'r3':
    case 'stop':
      return REMINDER_R3
    default:
      return null
  }
}

export function wrapReminder(text: string): string {
  return `\n\n<system-reminder>\n${text}\n</system-reminder>`
}

export interface ToolLoopRecord {
  streak: number
  level: ToolLoopLevel
}

export interface ToolLoopTracker {
  /**
   * Record one executed tool call. Identical calls within the same batch are
   * counted once (concurrent read-only batches legitimately repeat calls);
   * the streak only grows across batches. Calls with a different key reset
   * the streak.
   */
  record(toolName: string, input: unknown): ToolLoopRecord
  /** Mark the end of a tool batch (one assistant response's tool calls). */
  endBatch(): void
}

export function createToolLoopTracker(): ToolLoopTracker {
  let currentKey: string | null = null
  let streak = 0
  let countedKeyThisBatch: string | null = null

  return {
    record(toolName: string, input: unknown): ToolLoopRecord {
      const key = toolCallKey(toolName, input)
      if (key !== countedKeyThisBatch) {
        countedKeyThisBatch = key
        if (key === currentKey) {
          streak += 1
        } else {
          currentKey = key
          streak = 1
        }
      }
      return { streak, level: levelForStreak(streak) }
    },
    endBatch(): void {
      countedKeyThisBatch = null
    },
  }
}

// ---------------------------------------------------------------------------
// Tool-result message reminder injection (structural, no type imports)
// ---------------------------------------------------------------------------

interface ToolResultBlockLike {
  type: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface MessageLike {
  type: string
  message?: { content?: unknown }
}

function appendToBlockContent(
  block: ToolResultBlockLike,
  suffix: string,
): void {
  if (typeof block.content === 'string') {
    block.content += suffix
    return
  }
  if (Array.isArray(block.content)) {
    const last = block.content[block.content.length - 1] as
      | { type?: string; text?: string }
      | undefined
    if (last && last.type === 'text' && typeof last.text === 'string') {
      last.text += suffix
    } else {
      block.content.push({ type: 'text', text: suffix })
    }
    return
  }
  block.content = suffix
}

export interface ToolLoopApplyResult {
  /** True when the force-stop threshold was reached on any call. */
  forceStop: boolean
  /** Highest level reached in this message (for debug logging). */
  maxLevel: ToolLoopLevel
}

/**
 * Feed one tool-result message into the tracker and append graduated
 * reminders in place (before the message is yielded / sent back to the API).
 *
 * Only non-error results are counted: permission denials and tool errors
 * arrive as is_error tool_results, and a user repeatedly rejecting the same
 * Edit is legitimate behavior that must never trip the force-stop.
 */
export function applyToolLoopDetection(
  tracker: ToolLoopTracker,
  message: MessageLike,
  callInfoById: ReadonlyMap<string, { name: string; input: unknown }>,
): ToolLoopApplyResult {
  const result: ToolLoopApplyResult = { forceStop: false, maxLevel: 'none' }
  if (message.type !== 'user') return result
  const content = message.message?.content
  if (!Array.isArray(content)) return result

  const rank: ToolLoopLevel[] = ['none', 'r1', 'r2', 'r3', 'stop']
  for (const block of content as ToolResultBlockLike[]) {
    if (!block || block.type !== 'tool_result' || block.is_error === true) {
      continue
    }
    const info = block.tool_use_id
      ? callInfoById.get(block.tool_use_id)
      : undefined
    if (!info) continue
    const { level } = tracker.record(info.name, info.input)
    if (rank.indexOf(level) > rank.indexOf(result.maxLevel)) {
      result.maxLevel = level
    }
    const reminder = reminderForLevel(level)
    if (reminder) {
      appendToBlockContent(block, wrapReminder(reminder))
    }
    if (level === 'stop') {
      result.forceStop = true
    }
  }
  return result
}
