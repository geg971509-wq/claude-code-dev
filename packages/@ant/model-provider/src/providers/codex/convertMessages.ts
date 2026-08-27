import type {
  ResponseFunctionToolCallOutputItem,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputText,
} from 'openai/resources/responses/responses.mjs'
import type { Message } from '../../types/index.js'
import { normalizeCodexCallId, resolveCodexCallId } from './callIds.js'

type ContentBlock = {
  type: string
  text?: string
  source?: {
    type?: string
    data?: string
    media_type?: string
    url?: string
  }
}

type ToolUseLikeBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

type ToolResultLikeBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | ReadonlyArray<ContentBlock>
}

type CodexCallIdState = {
  byOriginalId: Map<string, string>
  sequence: number
}

const REMOTE_IMAGE_URL_PLACEHOLDER =
  'image content omitted because remote image URLs are not supported'
const IMAGE_PROCESSING_ERROR_PLACEHOLDER =
  'image content omitted because it could not be processed'

function createInputText(text: string): ResponseInputText {
  return {
    type: 'input_text',
    text,
  }
}

function createInputImage(imageUrl: string): ResponseInputImage {
  return {
    type: 'input_image',
    image_url: imageUrl,
    detail: 'high',
  }
}

function getUnsupportedBlockText(type: string): string | null {
  switch (type) {
    case 'document':
      return '[Document omitted: codex gateway does not support document replay.]'
    default:
      return null
  }
}

function isRemoteImageUrl(imageUrl: string): boolean {
  const colon = imageUrl.indexOf(':')
  if (colon <= 0) {
    return false
  }
  const scheme = imageUrl.slice(0, colon).toLowerCase()
  return scheme === 'http' || scheme === 'https'
}

function createDataUrl(data: string, mediaType?: string): string {
  const mime = mediaType && mediaType.length > 0 ? mediaType : 'image/png'
  return `data:${mime};base64,${data}`
}

function resolveImageUrl(block: ContentBlock): string | null {
  const source = block.source
  if (!source) {
    return null
  }

  if (typeof source.url === 'string' && source.url.length > 0) {
    if (isRemoteImageUrl(source.url)) {
      return null
    }
    return source.url
  }

  if (source.type === 'base64' && typeof source.data === 'string') {
    return createDataUrl(source.data, source.media_type)
  }

  return null
}

function convertImageBlock(
  block: ContentBlock,
): ResponseInputText | ResponseInputImage {
  const imageUrl = resolveImageUrl(block)
  if (imageUrl) {
    return createInputImage(imageUrl)
  }
  if (
    typeof block.source?.url === 'string' &&
    isRemoteImageUrl(block.source.url)
  ) {
    return createInputText(REMOTE_IMAGE_URL_PLACEHOLDER)
  }
  return createInputText(IMAGE_PROCESSING_ERROR_PLACEHOLDER)
}

function convertBlocksToInputContent(
  content: ReadonlyArray<ContentBlock>,
): Array<ResponseInputText | ResponseInputImage> {
  const output: Array<ResponseInputText | ResponseInputImage> = []

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      output.push(createInputText(block.text))
      continue
    }

    if (block.type === 'image') {
      output.push(convertImageBlock(block))
      continue
    }

    const fallback = getUnsupportedBlockText(block.type)
    if (fallback) {
      output.push(createInputText(fallback))
    }
  }

  return output
}

function convertToolResultOutput(
  content: string | ReadonlyArray<ContentBlock> | undefined,
): ResponseFunctionToolCallOutputItem['output'] {
  if (!content) {
    return ''
  }

  if (typeof content === 'string') {
    return content
  }

  const output = convertBlocksToInputContent(content)

  if (output.length === 0) {
    return ''
  }

  if (output.length === 1 && output[0].type === 'input_text') {
    return output[0].text
  }

  return output
}

function pushUserMessage(
  items: ResponseInputItem[],
  textParts: string[],
  imageUrls: string[] = [],
): void {
  const text = textParts.join('\n').trim()
  if (text.length === 0 && imageUrls.length === 0) {
    return
  }

  items.push({
    type: 'message',
    role: 'user',
    content: [
      ...(text.length > 0 ? [createInputText(text)] : []),
      ...imageUrls.map(createInputImage),
    ],
  } as unknown as ResponseInputItem)
}

function pushAssistantMessage(
  items: ResponseInputItem[],
  textParts: string[],
): void {
  const text = textParts.join('\n').trim()
  if (text.length === 0) {
    return
  }

  items.push({
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  } as unknown as ResponseInputItem)
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === 'string') {
    return input
  }

  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

function createCodexCallIdState(): CodexCallIdState {
  return {
    byOriginalId: new Map(),
    sequence: 0,
  }
}

function resolveAssistantCallId(
  block: ToolUseLikeBlock,
  state: CodexCallIdState,
): string {
  const originalId = typeof block.id === 'string' ? block.id : ''
  const seed = `${block.name}:${stringifyToolInput(block.input)}:${state.sequence}`
  const callId = resolveCodexCallId(originalId, seed)

  if (originalId.length > 0) {
    state.byOriginalId.set(originalId, callId)
  }
  state.sequence += 1

  return callId
}

function resolveToolResultCallId(
  toolUseId: unknown,
  state: CodexCallIdState,
): string | null {
  if (typeof toolUseId !== 'string') {
    return null
  }

  return state.byOriginalId.get(toolUseId) ?? normalizeCodexCallId(toolUseId)
}

function convertUserContentToInputItems(
  items: ResponseInputItem[],
  content: ReadonlyArray<string | ContentBlock>,
  callIdState: CodexCallIdState,
): void {
  const textParts: string[] = []
  const imageUrls: string[] = []

  for (const block of content) {
    if (typeof block === 'string') {
      textParts.push(block)
      continue
    }

    if (block.type === 'tool_result') {
      pushUserMessage(items, textParts, imageUrls)
      textParts.length = 0
      imageUrls.length = 0

      const toolResultBlock = block as ToolResultLikeBlock
      const callId = resolveToolResultCallId(
        toolResultBlock.tool_use_id,
        callIdState,
      )
      if (!callId) {
        continue
      }

      items.push({
        type: 'function_call_output',
        call_id: callId,
        output: convertToolResultOutput(toolResultBlock.content),
      })
      continue
    }

    if (block.type === 'text' && block.text) {
      textParts.push(block.text)
      continue
    }

    if (block.type === 'image') {
      const converted = convertImageBlock(block)
      if (converted.type === 'input_image') {
        if (converted.image_url) {
          imageUrls.push(converted.image_url)
        }
        continue
      }
      textParts.push(converted.text)
      continue
    }

    const fallback = getUnsupportedBlockText(block.type)
    if (fallback) {
      textParts.push(fallback)
    }
  }

  pushUserMessage(items, textParts, imageUrls)
}

function convertAssistantContentToInputItems(
  items: ResponseInputItem[],
  content: ReadonlyArray<string | ContentBlock>,
  callIdState: CodexCallIdState,
): void {
  const textParts: string[] = []

  for (const block of content) {
    if (typeof block === 'string') {
      textParts.push(block)
      continue
    }

    if (block.type === 'tool_use') {
      pushAssistantMessage(items, textParts)
      textParts.length = 0

      const toolUseBlock = block as unknown as ToolUseLikeBlock
      items.push({
        type: 'function_call',
        call_id: resolveAssistantCallId(toolUseBlock, callIdState),
        name: toolUseBlock.name,
        arguments: stringifyToolInput(toolUseBlock.input),
      })
      continue
    }

    if (block.type === 'text' && block.text) {
      textParts.push(block.text)
    }
  }

  pushAssistantMessage(items, textParts)
}

export function anthropicMessagesToCodexInput(
  messages: Message[],
): ResponseInputItem[] {
  const items: ResponseInputItem[] = []
  const callIdState = createCodexCallIdState()

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }

    const apiMessage = message.message
    if (!apiMessage?.content) {
      continue
    }

    if (typeof apiMessage.content === 'string') {
      if (message.type === 'user') {
        pushUserMessage(items, [apiMessage.content])
      } else {
        pushAssistantMessage(items, [apiMessage.content])
      }
      continue
    }

    if (message.type === 'user') {
      convertUserContentToInputItems(
        items,
        apiMessage.content as ReadonlyArray<string | ContentBlock>,
        callIdState,
      )
    } else {
      convertAssistantContentToInputItems(
        items,
        apiMessage.content as ReadonlyArray<string | ContentBlock>,
        callIdState,
      )
    }
  }

  return items
}
