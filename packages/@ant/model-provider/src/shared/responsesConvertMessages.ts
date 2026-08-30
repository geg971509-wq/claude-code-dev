import type {
  ResponseFunctionToolCallOutputItem,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputText,
} from 'openai/resources/responses/responses.mjs'
import type { Message } from '../types/index.js'
import {
  normalizeResponsesCallId,
  resolveResponsesCallId,
} from './responsesCallIds.js'

type ContentBlock = {
  type: string
  text?: string
  thinking?: string
  signature?: string
  data?: string
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

type ResponsesCallIdState = {
  byOriginalId: Map<string, string>
  used: Set<string>
  sequence: number
}

export type ResponsesMessageConversionOptions = {
  allowRemoteImageUrls?: boolean
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

function resolveImageUrl(
  block: ContentBlock,
  allowRemoteImageUrls: boolean,
): string | null {
  const source = block.source
  if (!source) {
    return null
  }

  if (typeof source.url === 'string' && source.url.length > 0) {
    if (!allowRemoteImageUrls && isRemoteImageUrl(source.url)) {
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
  allowRemoteImageUrls: boolean,
): ResponseInputText | ResponseInputImage {
  const imageUrl = resolveImageUrl(block, allowRemoteImageUrls)
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
  allowRemoteImageUrls: boolean,
): Array<ResponseInputText | ResponseInputImage> {
  const output: Array<ResponseInputText | ResponseInputImage> = []

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      output.push(createInputText(block.text))
      continue
    }

    if (block.type === 'image') {
      output.push(convertImageBlock(block, allowRemoteImageUrls))
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
  allowRemoteImageUrls: boolean,
): ResponseFunctionToolCallOutputItem['output'] {
  if (!content) {
    return ''
  }

  if (typeof content === 'string') {
    return content
  }

  const output = convertBlocksToInputContent(content, allowRemoteImageUrls)

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
  content: Array<ResponseInputText | ResponseInputImage>,
): void {
  if (content.length === 0) {
    return
  }

  items.push({
    type: 'message',
    role: 'user',
    content,
  } as unknown as ResponseInputItem)
}

function pushAssistantMessage(
  items: ResponseInputItem[],
  textParts: string[],
): void {
  if (textParts.length === 0) {
    return
  }

  items.push({
    type: 'message',
    role: 'assistant',
    content: textParts.map(text => ({
      type: 'output_text',
      text,
      annotations: [],
    })),
  } as unknown as ResponseInputItem)
}

function pushReasoningItem(
  items: ResponseInputItem[],
  block: ContentBlock,
): void {
  const encryptedContent =
    typeof block.signature === 'string' && block.signature.length > 0
      ? block.signature
      : typeof block.data === 'string' && block.data.length > 0
        ? block.data
        : undefined
  if (!encryptedContent) return

  const summaryText =
    typeof block.thinking === 'string' ? block.thinking.trim() : ''
  items.push({
    type: 'reasoning',
    encrypted_content: encryptedContent,
    summary:
      summaryText.length > 0
        ? [{ type: 'summary_text', text: summaryText }]
        : [],
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

function createResponsesCallIdState(): ResponsesCallIdState {
  return {
    byOriginalId: new Map(),
    used: new Set(),
    sequence: 0,
  }
}

function resolveAssistantCallId(
  block: ToolUseLikeBlock,
  state: ResponsesCallIdState,
): string {
  const originalId = typeof block.id === 'string' ? block.id : ''
  const seed = `${block.name}:${stringifyToolInput(block.input)}:${state.sequence}`
  let callId = resolveResponsesCallId(originalId, seed)
  let salt = 0
  while (state.used.has(callId)) {
    callId = resolveResponsesCallId('', `${originalId}:${seed}:${salt}`)
    salt += 1
  }

  if (originalId.length > 0) {
    state.byOriginalId.set(originalId, callId)
  }
  state.used.add(callId)
  state.sequence += 1

  return callId
}

function resolveToolResultCallId(
  toolUseId: unknown,
  state: ResponsesCallIdState,
): string | null {
  if (typeof toolUseId !== 'string') {
    return null
  }

  return (
    state.byOriginalId.get(toolUseId) ?? normalizeResponsesCallId(toolUseId)
  )
}

function convertUserContentToInputItems(
  items: ResponseInputItem[],
  content: ReadonlyArray<string | ContentBlock>,
  callIdState: ResponsesCallIdState,
  allowRemoteImageUrls: boolean,
): void {
  const messageContent: Array<ResponseInputText | ResponseInputImage> = []

  for (const block of content) {
    if (typeof block === 'string') {
      messageContent.push(createInputText(block))
      continue
    }

    if (block.type === 'tool_result') {
      pushUserMessage(items, messageContent.splice(0))

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
        output: convertToolResultOutput(
          toolResultBlock.content,
          allowRemoteImageUrls,
        ),
      })
      continue
    }

    if (block.type === 'text' && block.text) {
      messageContent.push(createInputText(block.text))
      continue
    }

    if (block.type === 'image') {
      messageContent.push(convertImageBlock(block, allowRemoteImageUrls))
      continue
    }

    const fallback = getUnsupportedBlockText(block.type)
    if (fallback) {
      messageContent.push(createInputText(fallback))
    }
  }

  pushUserMessage(items, messageContent)
}

function convertAssistantContentToInputItems(
  items: ResponseInputItem[],
  content: ReadonlyArray<string | ContentBlock>,
  callIdState: ResponsesCallIdState,
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

    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      pushAssistantMessage(items, textParts)
      textParts.length = 0
      pushReasoningItem(items, block)
      continue
    }

    if (block.type === 'text' && block.text) {
      textParts.push(block.text)
    }
  }

  pushAssistantMessage(items, textParts)
}

export function anthropicMessagesToResponsesInput(
  messages: Message[],
  options: ResponsesMessageConversionOptions = {},
): ResponseInputItem[] {
  const items: ResponseInputItem[] = []
  const callIdState = createResponsesCallIdState()
  const allowRemoteImageUrls = options.allowRemoteImageUrls === true

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
        pushUserMessage(items, [createInputText(apiMessage.content)])
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
        allowRemoteImageUrls,
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
