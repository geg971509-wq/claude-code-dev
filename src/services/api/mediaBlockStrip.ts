import type { AssistantMessage, UserMessage } from 'src/types/message.js'

/**
 * 400 里被点名"处理不了"的那一块媒体的坐标。
 *
 * 服务端拒绝一张图/一份 PDF 时会在报文里给出它在**请求体**里的位置
 * （`messages.3.content.1.image`，工具结果里的图则是
 * `messages.3.content.1.tool_result.content.0.image`）。dev 此前对这类 400
 * 的唯一出路是 reactive compact —— 把整段对话压掉来把坏块挤出窗口，代价是
 * 丢历史，而且坏块若落在保留的尾部就压不掉，只能连着报错。既然服务端已经
 * 把坐标告诉我们了，直接换掉那一块就行。
 *
 * 正则与官方同形，只多捕获一个 tool_result 内层下标：报文措辞和索引写法
 * （`messages.3.content.1` 与 `messages[3].content[1]` 两种都出现过）由服务
 * 端决定，这里没有自由发挥的余地。
 */
export type MediaBlockCoords = {
  messageIdx: number
  contentIdx: number
  /** 坏块嵌在 tool_result 里时，它在 tool_result.content 中的下标。 */
  innerIdx?: number
  kind: string
}

const COORDS =
  /messages[.[](\d+)[\].]+content[.[](\d+)[\].]+(?:tool_result[.[]content[.[](\d+)[\].]+)?(image|document|pdf)/

export function parseUnprocessableMedia(
  raw: string | undefined,
): MediaBlockCoords | undefined {
  const matched = raw ? COORDS.exec(raw) : null
  if (!matched) {
    return undefined
  }
  return {
    messageIdx: Number(matched[1]),
    contentIdx: Number(matched[2]),
    ...(matched[3] !== undefined && { innerIdx: Number(matched[3]) }),
    kind: matched[4]!,
  }
}

export function sameCoords(a: MediaBlockCoords, b: MediaBlockCoords): boolean {
  return (
    a.messageIdx === b.messageIdx &&
    a.contentIdx === b.contentIdx &&
    a.innerIdx === b.innerIdx
  )
}

type ApiMessage = UserMessage | AssistantMessage
type Block = { type?: string; content?: unknown }

function placeholder(kind: string): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: `[${kind} removed: the API could not process it]`,
  }
}

/**
 * 把坐标处的内容块换成一段占位文本。
 *
 * **换**而不是删：坐标是按请求体的下标给的，删除会让后面所有块前移，于是
 * 同一请求里第二块坏媒体报回来的坐标就对不上了。换成同位置的文本块，下标
 * 全程稳定，也不会破坏 tool_result 的配对。
 *
 * 只在该位置**确实是**媒体块时才动手。消息层面 addCacheBreakpoints 是严格
 * 的 1:1 map，下标可靠；内容块的转换则不保证逐块对齐，对不上时宁可放弃，
 * 由原有的 reactive compact 兜底 —— 换错一块比不换更糟。
 */
export function stripMediaBlockAt(
  messages: readonly ApiMessage[],
  coords: MediaBlockCoords,
): ApiMessage[] | undefined {
  const target = messages[coords.messageIdx]
  const content = target?.message.content
  if (!target || !Array.isArray(content)) {
    return undefined
  }
  const outer = content[coords.contentIdx] as Block | undefined
  if (!outer) {
    return undefined
  }

  let nextBlock: unknown
  if (coords.innerIdx === undefined) {
    if (outer.type !== 'image' && outer.type !== 'document') {
      return undefined
    }
    nextBlock = placeholder(coords.kind)
  } else {
    if (outer.type !== 'tool_result' || !Array.isArray(outer.content)) {
      return undefined
    }
    const inner = outer.content[coords.innerIdx] as Block | undefined
    if (inner?.type !== 'image' && inner?.type !== 'document') {
      return undefined
    }
    const innerContent = [...outer.content]
    innerContent[coords.innerIdx] = placeholder(coords.kind)
    nextBlock = { ...outer, content: innerContent }
  }

  const nextContent = [...content]
  nextContent[coords.contentIdx] = nextBlock as (typeof nextContent)[number]
  const out = [...messages]
  out[coords.messageIdx] = {
    ...target,
    message: { ...target.message, content: nextContent },
  } as ApiMessage
  return out
}
