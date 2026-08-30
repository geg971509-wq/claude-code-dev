import { describe, expect, test } from 'bun:test'
import { createAttachmentMessage } from '../attachments.js'
import {
  deserializeMessagesWithInterruptDetection,
  validateResumeDropRange,
} from '../conversationRecovery.js'
import {
  createAssistantMessage,
  createUserMessage,
  NO_RESPONSE_REQUESTED,
} from '../messages.js'

const TURN_A = '11111111-1111-4111-8111-111111111111'
const TURN_B = '22222222-2222-4222-8222-222222222222'

describe('conversation recovery Claude parity', () => {
  test('reply-on-resume leaves a trailing user turn continuable', () => {
    const user = createUserMessage({ content: 'continue me', uuid: TURN_A })

    const normal = deserializeMessagesWithInterruptDetection([user])
    const replyOnResume = deserializeMessagesWithInterruptDetection(
      [user],
      true,
    )

    expect(normal.messages.at(-1)?.type).toBe('assistant')
    expect(normal.messages.at(-1)?.message?.content).toEqual([
      { type: 'text', text: NO_RESPONSE_REQUESTED },
    ])
    expect(replyOnResume.messages.at(-1)?.type).toBe('user')
    expect(replyOnResume.messages.at(-1)?.uuid).toBe(TURN_A)
  })

  test('resume-drops-turn accepts only entries attributable to the declared turn', () => {
    const declaredPrompt = createUserMessage({
      content: 'declared turn',
      uuid: TURN_A,
    })
    const assistant = createAssistantMessage({ content: 'working' })
    const toolResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'done',
        },
      ],
      uuid: TURN_A,
    })

    expect(
      validateResumeDropRange([declaredPrompt, assistant, toolResult], TURN_A),
    ).toEqual({ ok: true })
  })

  test('resume-drops-turn rejects queued content and another human turn', () => {
    const declaredPrompt = createUserMessage({
      content: 'declared turn',
      uuid: TURN_A,
    })
    const queued = createAttachmentMessage({
      type: 'queued_command',
      prompt: 'late input',
    })
    const otherTurn = createUserMessage({
      content: 'next turn',
      uuid: TURN_B,
    })

    expect(validateResumeDropRange([declaredPrompt, queued], TURN_A)).toEqual({
      ok: false,
      reason: expect.stringContaining('absorbed queued content'),
    })
    expect(
      validateResumeDropRange([declaredPrompt, otherTurn], TURN_A),
    ).toEqual({
      ok: false,
      reason: expect.stringContaining(
        'user entry not attributable to the declared turn',
      ),
    })
  })

  test('resume-drops-turn rejects a malformed declared turn id', () => {
    expect(validateResumeDropRange([], 'not-a-uuid')).toEqual({
      ok: false,
      reason: 'declared turn id is not a UUID: not-a-uuid',
    })
  })
})
