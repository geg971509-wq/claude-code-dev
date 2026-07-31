import { describe, expect, test } from 'bun:test'
import {
  applyToolLoopDetection,
  createToolLoopTracker,
  levelForStreak,
  REPEAT_FORCE_STOP_STREAK,
  reminderForLevel,
  stableStringify,
  toolCallKey,
} from '../toolLoopDetection'

describe('stableStringify', () => {
  test('sorts object keys recursively', () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 2 }),
    )
  })

  test('preserves array order', () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]))
  })

  test('falls back to String() for non-serializable input', () => {
    expect(stableStringify(undefined)).toBe('undefined')
  })
})

describe('toolCallKey', () => {
  test('combines tool name and canonical args', () => {
    expect(toolCallKey('Read', { file_path: '/a' })).toBe(
      'Read {"file_path":"/a"}',
    )
  })

  test('truncates oversized inputs', () => {
    const big = { data: 'x'.repeat(10000) }
    expect(toolCallKey('Write', big).length).toBeLessThan(4200)
  })
})

describe('levelForStreak', () => {
  test('maps streaks to escalation levels', () => {
    expect(levelForStreak(1)).toBe('none')
    expect(levelForStreak(2)).toBe('none')
    expect(levelForStreak(3)).toBe('r1')
    expect(levelForStreak(4)).toBe('r1')
    expect(levelForStreak(5)).toBe('r2')
    expect(levelForStreak(8)).toBe('r3')
    expect(levelForStreak(REPEAT_FORCE_STOP_STREAK)).toBe('stop')
    expect(levelForStreak(99)).toBe('stop')
  })
})

describe('reminderForLevel', () => {
  test('returns text for intervention levels and null for none', () => {
    expect(reminderForLevel('none')).toBeNull()
    expect(reminderForLevel('r1')).toContain('new information')
    expect(reminderForLevel('r2')).toContain('Falsification')
    expect(reminderForLevel('r3')).toContain('without any further tool calls')
    expect(reminderForLevel('stop')).toBe(reminderForLevel('r3'))
  })
})

describe('createToolLoopTracker', () => {
  test('increments streak across batches for identical calls', () => {
    const tracker = createToolLoopTracker()
    const input = { file_path: '/a' }
    expect(tracker.record('Read', input).streak).toBe(1)
    tracker.endBatch()
    expect(tracker.record('Read', input).streak).toBe(2)
    tracker.endBatch()
    expect(tracker.record('Read', input).level).toBe('r1')
  })

  test('counts identical calls only once per batch', () => {
    const tracker = createToolLoopTracker()
    const input = { file_path: '/a' }
    tracker.record('Read', input)
    tracker.record('Read', input)
    expect(tracker.record('Read', input).streak).toBe(1)
  })

  test('resets streak when a different call intervenes', () => {
    const tracker = createToolLoopTracker()
    tracker.record('Read', { file_path: '/a' })
    tracker.endBatch()
    tracker.record('Read', { file_path: '/b' })
    tracker.endBatch()
    expect(tracker.record('Read', { file_path: '/a' }).streak).toBe(1)
  })

  test('treats key order as insignificant', () => {
    const tracker = createToolLoopTracker()
    tracker.record('Edit', { a: 1, b: 2 })
    tracker.endBatch()
    expect(tracker.record('Edit', { b: 2, a: 1 }).streak).toBe(2)
  })
})

function makeToolResultMessage(
  toolUseId: string,
  content: unknown = 'ok',
  isError = false,
) {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  }
}

describe('applyToolLoopDetection', () => {
  const callInfo = new Map([['t1', { name: 'Read', input: { f: 1 } }]])

  test('does not modify results below the threshold', () => {
    const tracker = createToolLoopTracker()
    const msg = makeToolResultMessage('t1', 'ok')
    const result = applyToolLoopDetection(tracker, msg, callInfo)
    expect(result.maxLevel).toBe('none')
    expect(result.forceStop).toBe(false)
    expect(msg.message.content[0].content).toBe('ok')
  })

  test('appends a system-reminder to string content at r1', () => {
    const tracker = createToolLoopTracker()
    let msg = makeToolResultMessage('t1', 'ok')
    for (let i = 0; i < 2; i++) {
      applyToolLoopDetection(tracker, msg, callInfo)
      tracker.endBatch()
    }
    msg = makeToolResultMessage('t1', 'ok')
    const result = applyToolLoopDetection(tracker, msg, callInfo)
    expect(result.maxLevel).toBe('r1')
    expect(msg.message.content[0].content).toContain('<system-reminder>')
    expect((msg.message.content[0].content as string).startsWith('ok')).toBe(
      true,
    )
  })

  test('appends to array content by extending the last text block', () => {
    const tracker = createToolLoopTracker()
    for (let i = 0; i < 2; i++) {
      applyToolLoopDetection(tracker, makeToolResultMessage('t1'), callInfo)
      tracker.endBatch()
    }
    const msg = makeToolResultMessage('t1', [{ type: 'text', text: 'partial' }])
    applyToolLoopDetection(tracker, msg, callInfo)
    const blocks = msg.message.content[0].content as Array<{
      type: string
      text: string
    }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toContain('partial')
    expect(blocks[0]!.text).toContain('<system-reminder>')
  })

  test('ignores error results (permission denials never escalate)', () => {
    const tracker = createToolLoopTracker()
    for (let i = 0; i < REPEAT_FORCE_STOP_STREAK + 2; i++) {
      const result = applyToolLoopDetection(
        tracker,
        makeToolResultMessage('t1', 'denied', true),
        callInfo,
      )
      expect(result.maxLevel).toBe('none')
      expect(result.forceStop).toBe(false)
      tracker.endBatch()
    }
  })

  test('ignores non-tool-result and unknown-id blocks', () => {
    const tracker = createToolLoopTracker()
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_result', tool_use_id: 'unknown', content: 'x' },
        ],
      },
    }
    const result = applyToolLoopDetection(tracker, msg, callInfo)
    expect(result.maxLevel).toBe('none')
  })

  test('reaches force stop at the hard threshold', () => {
    const tracker = createToolLoopTracker()
    let forceStop = false
    for (let i = 0; i < REPEAT_FORCE_STOP_STREAK; i++) {
      const result = applyToolLoopDetection(
        tracker,
        makeToolResultMessage('t1'),
        callInfo,
      )
      forceStop = result.forceStop
      tracker.endBatch()
    }
    expect(forceStop).toBe(true)
  })

  test('returns none for non-user messages', () => {
    const tracker = createToolLoopTracker()
    const result = applyToolLoopDetection(
      tracker,
      { type: 'assistant', message: { content: [] } },
      callInfo,
    )
    expect(result.maxLevel).toBe('none')
  })
})
