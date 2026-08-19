import { describe, expect, test } from 'bun:test'
import type { UserMessage } from 'src/types/message.js'
import {
  parseUnprocessableMedia,
  sameCoords,
  stripMediaBlockAt,
} from '../mediaBlockStrip.js'

function userMessage(content: unknown[]): UserMessage {
  return {
    type: 'user',
    uuid: 'test-uuid',
    message: { role: 'user', content },
  } as unknown as UserMessage
}

describe('parseUnprocessableMedia', () => {
  test('reads dotted coordinates', () => {
    expect(
      parseUnprocessableMedia('messages.3.content.1.image: could not process'),
    ).toEqual({ messageIdx: 3, contentIdx: 1, kind: 'image' })
  })

  test('reads bracketed coordinates', () => {
    // 服务端两种写法都出现过，只支持一种就等于随机失效。
    expect(
      parseUnprocessableMedia('messages[0].content[2].document is invalid'),
    ).toEqual({ messageIdx: 0, contentIdx: 2, kind: 'document' })
  })

  test('reads the inner index for media inside a tool_result', () => {
    // 编码 CLI 里最常见的一类坏媒体就是工具返回的截图。
    expect(
      parseUnprocessableMedia(
        'messages.5.content.0.tool_result.content.2.image failed',
      ),
    ).toEqual({ messageIdx: 5, contentIdx: 0, innerIdx: 2, kind: 'image' })
  })

  test('returns undefined when the 400 names no coordinates', () => {
    expect(
      parseUnprocessableMedia('image exceeds maximum size'),
    ).toBeUndefined()
  })
})

describe('stripMediaBlockAt', () => {
  test('replaces the block in place so later coordinates still line up', () => {
    const messages = [
      userMessage([
        { type: 'text', text: 'before' },
        { type: 'image', source: { data: 'xxx' } },
        { type: 'text', text: 'after' },
      ]),
    ]
    const out = stripMediaBlockAt(messages, {
      messageIdx: 0,
      contentIdx: 1,
      kind: 'image',
    })
    const content = out?.[0]?.message.content as {
      type: string
      text?: string
    }[]
    expect(content).toHaveLength(3)
    expect(content[1]).toEqual({
      type: 'text',
      text: '[image removed: the API could not process it]',
    })
    // 原数组不能被就地改动 —— 上层还要拿它做别的事。
    expect(
      (messages[0]!.message.content as { type: string; text?: string }[])[1]
        ?.type,
    ).toBe('image')
  })

  test('reaches into tool_result content', () => {
    const messages = [
      userMessage([
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'image', source: { data: 'xxx' } },
          ],
        },
      ]),
    ]
    const out = stripMediaBlockAt(messages, {
      messageIdx: 0,
      contentIdx: 0,
      innerIdx: 1,
      kind: 'image',
    })
    const inner = (
      out?.[0]?.message.content as {
        content: { type: string; text?: string }[]
      }[]
    )[0]
    expect(inner?.content[1]).toEqual({
      type: 'text',
      text: '[image removed: the API could not process it]',
    })
  })

  test('bails when the coordinates do not point at media', () => {
    // 内容块的转换不保证逐块对齐；对不上时宁可什么都不做，交给
    // reactive compact 兜底 —— 换错一块比不换更糟。
    const messages = [userMessage([{ type: 'text', text: 'hello' }])]
    expect(
      stripMediaBlockAt(messages, {
        messageIdx: 0,
        contentIdx: 0,
        kind: 'image',
      }),
    ).toBeUndefined()
  })

  test('bails on out-of-range coordinates', () => {
    const messages = [userMessage([{ type: 'text', text: 'hello' }])]
    expect(
      stripMediaBlockAt(messages, {
        messageIdx: 9,
        contentIdx: 0,
        kind: 'image',
      }),
    ).toBeUndefined()
  })
})

describe('sameCoords', () => {
  test('distinguishes tool_result inner positions', () => {
    const base = { messageIdx: 1, contentIdx: 0, kind: 'image' }
    expect(sameCoords({ ...base, innerIdx: 0 }, { ...base, innerIdx: 1 })).toBe(
      false,
    )
    expect(sameCoords({ ...base, innerIdx: 1 }, { ...base, innerIdx: 1 })).toBe(
      true,
    )
  })
})
