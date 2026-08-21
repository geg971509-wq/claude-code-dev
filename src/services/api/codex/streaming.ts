import { randomUUID } from 'crypto'
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses.mjs'
import type { AssistantMessage, StreamEvent } from '../../../types/message.js'
import type { Tools } from '../../../Tool.js'
import {
  createAssistantMessage,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'
import { getCodexClient } from './client.js'
import { ProviderStreamError, resolveCodexCallId } from '@ant/model-provider'
import {
  isSemanticOpenAIEvent,
  withOpenAIStreamIdleTimeout,
} from '../openai/openaiShared.js'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

export type RawAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: string }

export type CodexUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export type CodexStreamResult = {
  response?: Response
  incompleteResponse?: Response
  partialMessage?: AssistantMessage['message']
  assistantBlocks: RawAssistantBlock[]
}

type CodexStreamState = {
  contentBlocks: Record<number, RawAssistantBlock>
  completedBlocks: Array<RawAssistantBlock | undefined>
  partialMessage?: AssistantMessage['message']
  finalResponse?: Response
  incompleteResponse?: Response
  failedResponse?: Response
}

export function getCodexUsage(
  response: Pick<Response, 'usage'> | null | undefined,
): CodexUsage {
  return {
    input_tokens: response?.usage?.input_tokens ?? 0,
    output_tokens: response?.usage?.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens:
      response?.usage?.input_tokens_details.cached_tokens ?? 0,
  }
}

export function addCodexUsage(
  total: CodexUsage,
  response: Pick<Response, 'usage'> | null | undefined,
): CodexUsage {
  const usage = getCodexUsage(response)

  return {
    input_tokens: total.input_tokens + usage.input_tokens,
    output_tokens: total.output_tokens + usage.output_tokens,
    cache_creation_input_tokens:
      total.cache_creation_input_tokens + usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      total.cache_read_input_tokens + usage.cache_read_input_tokens,
  }
}

function createPartialAssistantMessage(
  response: Response,
): AssistantMessage['message'] {
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    content: [],
    model: response.model,
    stop_reason: null,
    stop_sequence: null,
    usage: getCodexUsage(response) as any,
  } as AssistantMessage['message']
}

function createToolUseBlock(
  item: Partial<ResponseFunctionToolCall> & { id?: string },
): RawAssistantBlock {
  return {
    type: 'tool_use',
    id: resolveCodexCallId(
      item.call_id ?? item.id,
      `tool:${item.name ?? ''}:${item.arguments ?? ''}:${item.id ?? ''}`,
    ),
    name: item.name ?? '',
    input: item.arguments ?? '',
  }
}

function getCompletedTextFromItem(item: ResponseOutputItem): string | null {
  if (item.type !== 'message' || item.role !== 'assistant') {
    return null
  }

  for (const content of (item as ResponseOutputMessage).content) {
    if (content.type === 'output_text' && content.text.length > 0) {
      return content.text
    }
    if (content.type === 'refusal' && content.refusal.length > 0) {
      return content.refusal
    }
  }

  return null
}

function getCompletedAssistantBlocks(
  blocks: Array<RawAssistantBlock | undefined>,
): RawAssistantBlock[] {
  return blocks.filter(
    (block): block is RawAssistantBlock => block !== undefined,
  )
}

function getCodexStopReason(
  response: Pick<Response, 'incomplete_details'>,
  blocks: RawAssistantBlock[],
): string {
  if (response.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens'
  }

  return blocks.some(block => block.type === 'tool_use')
    ? 'tool_use'
    : 'end_turn'
}

function emitTrailingTextDelta(
  output: StreamEvent[],
  index: number,
  currentText: string,
  finalText: string,
): void {
  if (!finalText.startsWith(currentText)) {
    return
  }

  const delta = finalText.slice(currentText.length)
  if (delta.length === 0) {
    return
  }

  output.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'text_delta',
        text: delta,
      },
    } as any,
  } as StreamEvent)
}

function emitTrailingToolDelta(
  output: StreamEvent[],
  index: number,
  currentInput: string,
  finalInput: string,
): void {
  if (!finalInput.startsWith(currentInput)) {
    return
  }

  const delta = finalInput.slice(currentInput.length)
  if (delta.length === 0) {
    return
  }

  output.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: delta,
      },
    } as any,
  } as StreamEvent)
}

function responseToRawAssistantBlocks(response: Response): RawAssistantBlock[] {
  const blocks: RawAssistantBlock[] = []

  for (const item of response.output) {
    if (item.type === 'function_call') {
      const functionCall = item as ResponseFunctionToolCall
      blocks.push({
        type: 'tool_use',
        id: resolveCodexCallId(
          functionCall.call_id,
          `output:${functionCall.name}:${functionCall.arguments}`,
        ),
        name: functionCall.name,
        input: functionCall.arguments,
      })
      continue
    }

    if (item.type !== 'message' || item.role !== 'assistant') {
      continue
    }

    for (const content of (item as ResponseOutputMessage).content) {
      if (content.type === 'output_text' && content.text.length > 0) {
        blocks.push({
          type: 'text',
          text: content.text,
        })
      } else if (content.type === 'refusal' && content.refusal.length > 0) {
        blocks.push({
          type: 'text',
          text: content.refusal,
        })
      }
    }
  }

  if (
    blocks.length === 0 &&
    typeof response.output_text === 'string' &&
    response.output_text.length > 0
  ) {
    blocks.push({
      type: 'text',
      text: response.output_text,
    })
  }

  return blocks
}

export function rawAssistantBlocksToAssistantMessage(
  rawBlocks: RawAssistantBlock[],
  response: Pick<Response, 'id' | 'model' | 'usage' | 'incomplete_details'>,
  tools: Tools,
  agentId?: string,
): AssistantMessage {
  const content = normalizeContentFromAPI(
    rawBlocks as any,
    tools,
    agentId as any,
  )

  const assistantMessage = createAssistantMessage({
    content: content as any,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens:
        response.usage?.input_tokens_details.cached_tokens ?? 0,
    } as any,
  })

  assistantMessage.message.id = response.id
  assistantMessage.message.model = response.model
  assistantMessage.message.stop_reason = getCodexStopReason(
    response,
    rawBlocks,
  ) as any
  assistantMessage.message.stop_sequence = null
  assistantMessage.uuid = randomUUID()
  assistantMessage.timestamp = new Date().toISOString()

  return assistantMessage
}

function handleCodexStreamEvent(params: {
  event: ResponseStreamEvent
  partialMessage: AssistantMessage['message'] | undefined
  contentBlocks: Record<number, RawAssistantBlock>
  completedBlocks: Array<RawAssistantBlock | undefined>
  start: number
}): {
  output: StreamEvent[]
  partialMessage: AssistantMessage['message'] | undefined
  finalResponse?: Response
  failedResponse?: Response
  incompleteResponse?: Response
} {
  const { event, start } = params
  const output: StreamEvent[] = []
  const contentBlocks = params.contentBlocks
  const completedBlocks = params.completedBlocks
  let partialMessage = params.partialMessage
  let finalResponse: Response | undefined
  let failedResponse: Response | undefined
  let incompleteResponse: Response | undefined

  const ensureMessageStart = (response: Response): void => {
    if (partialMessage) {
      return
    }

    partialMessage = createPartialAssistantMessage(response)
    output.push({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: partialMessage,
      } as any,
      ttftMs: Date.now() - start,
    } as StreamEvent)
  }

  const ensureTextBlock = (index: number): RawAssistantBlock => {
    const existing = contentBlocks[index]
    if (existing) {
      return existing
    }

    const block: RawAssistantBlock = { type: 'text', text: '' }
    contentBlocks[index] = block
    output.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      } as any,
    } as StreamEvent)
    return block
  }

  const ensureToolUseBlock = (
    index: number,
    item?: Partial<ResponseFunctionToolCall> & { id?: string },
  ): RawAssistantBlock => {
    const existing = contentBlocks[index]
    if (existing) {
      return existing
    }

    const block = createToolUseBlock(item ?? {})
    contentBlocks[index] = block
    const toolBlock = block as Extract<RawAssistantBlock, { type: 'tool_use' }>
    output.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: toolBlock.id,
          name: toolBlock.name,
          input: '',
        },
      } as any,
    } as StreamEvent)
    return block
  }

  const emitCompletedBlock = (index: number): void => {
    const block = contentBlocks[index]
    if (!block) {
      return
    }
    completedBlocks[index] = { ...block }
    output.push({
      type: 'stream_event',
      event: {
        type: 'content_block_stop',
        index,
      } as any,
    } as StreamEvent)
    delete contentBlocks[index]
  }

  switch (event.type) {
    case 'response.created':
    case 'response.in_progress':
      ensureMessageStart(event.response)
      break
    case 'response.output_item.added':
      if (event.item.type === 'function_call') {
        ensureToolUseBlock(event.output_index, event.item)
      } else if (
        event.item.type === 'message' &&
        event.item.role === 'assistant'
      ) {
        ensureTextBlock(event.output_index)
      }
      break
    case 'response.output_text.delta':
    case 'response.refusal.delta': {
      const block = ensureTextBlock(event.output_index)
      if (block.type === 'text') {
        block.text += event.delta
      }
      output.push({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: event.output_index,
          delta: {
            type: 'text_delta',
            text: event.delta,
          },
        } as any,
      } as StreamEvent)
      break
    }
    case 'response.function_call_arguments.delta': {
      const block = ensureToolUseBlock(event.output_index, {
        id: event.item_id,
      })
      if (block.type === 'tool_use') {
        block.input += event.delta
      }
      output.push({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: event.output_index,
          delta: {
            type: 'input_json_delta',
            partial_json: event.delta,
          },
        } as any,
      } as StreamEvent)
      break
    }
    case 'response.output_text.done':
    case 'response.refusal.done': {
      const block = ensureTextBlock(event.output_index)
      const finalText =
        event.type === 'response.output_text.done' ? event.text : event.refusal
      if (block.type === 'text') {
        emitTrailingTextDelta(output, event.output_index, block.text, finalText)
        block.text = finalText
      }
      emitCompletedBlock(event.output_index)
      break
    }
    case 'response.function_call_arguments.done': {
      const block = ensureToolUseBlock(event.output_index, {
        id: event.item_id,
        name: event.name,
      })
      if (block.type === 'tool_use') {
        if (event.name) {
          block.name = event.name
        }
        emitTrailingToolDelta(
          output,
          event.output_index,
          block.input,
          event.arguments,
        )
        block.input = event.arguments
      }
      emitCompletedBlock(event.output_index)
      break
    }
    case 'response.output_item.done':
      if (
        event.item.type === 'message' &&
        event.item.role === 'assistant' &&
        contentBlocks[event.output_index]
      ) {
        const finalText = getCompletedTextFromItem(event.item)
        if (finalText !== null) {
          const block = contentBlocks[event.output_index]
          if (block.type === 'text') {
            emitTrailingTextDelta(
              output,
              event.output_index,
              block.text,
              finalText,
            )
            block.text = finalText
          }
        }
        emitCompletedBlock(event.output_index)
      } else if (
        event.item.type === 'function_call' &&
        contentBlocks[event.output_index]
      ) {
        const block = contentBlocks[event.output_index]
        if (block.type === 'tool_use') {
          block.id = resolveCodexCallId(
            event.item.call_id,
            `done:${event.item.name}:${event.item.arguments}:${event.item.id}`,
          )
          block.name = event.item.name
          emitTrailingToolDelta(
            output,
            event.output_index,
            block.input,
            event.item.arguments,
          )
          block.input = event.item.arguments
        }
        emitCompletedBlock(event.output_index)
      }
      break
    case 'response.completed':
    case 'response.incomplete': {
      ensureMessageStart(event.response)
      if (event.type === 'response.completed') {
        finalResponse = event.response
      } else {
        incompleteResponse = event.response
      }
      const assistantBlocks = getCompletedAssistantBlocks(completedBlocks)
      output.push({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: {
            stop_reason: getCodexStopReason(event.response, assistantBlocks),
            stop_sequence: null,
          },
          usage: getCodexUsage(event.response),
        } as any,
      } as StreamEvent)
      output.push({
        type: 'stream_event',
        event: {
          type: 'message_stop',
        } as any,
      } as StreamEvent)
      break
    }
    case 'response.failed':
      failedResponse = event.response
      break
    case 'error':
      throw new Error(event.message)
  }

  return {
    output,
    partialMessage,
    finalResponse,
    failedResponse,
    incompleteResponse,
  }
}

function selectResponse(
  state: CodexStreamState,
  streamedResponse?: Response,
): CodexStreamResult {
  const response =
    [
      streamedResponse,
      state.finalResponse,
      state.incompleteResponse,
      state.failedResponse,
    ].find(
      candidate =>
        candidate !== undefined &&
        responseToRawAssistantBlocks(candidate).length > 0,
    ) ??
    streamedResponse ??
    state.finalResponse ??
    state.incompleteResponse ??
    state.failedResponse

  return {
    response,
    incompleteResponse: state.incompleteResponse,
    partialMessage: state.partialMessage,
    assistantBlocks:
      response !== undefined &&
      responseToRawAssistantBlocks(response).length > 0
        ? responseToRawAssistantBlocks(response)
        : getCompletedAssistantBlocks(state.completedBlocks),
  }
}

export async function* streamCodexAttempt(params: {
  client: ReturnType<typeof getCodexClient>
  requestBody: ResponseCreateParamsNonStreaming
  signal: AbortSignal
  start: number
  emitPrimaryEvents?: boolean
}): AsyncGenerator<StreamEvent, CodexStreamResult, void> {
  const attemptController = new AbortController()
  const onAbort = () => attemptController.abort()
  if (params.signal.aborted) {
    attemptController.abort()
  } else {
    params.signal.addEventListener('abort', onAbort, { once: true })
  }

  let committed = false
  try {
    const stream = params.client.responses.stream(
      params.requestBody as unknown as Parameters<
        typeof params.client.responses.stream
      >[0],
      { signal: attemptController.signal },
    )
    const timedStream = withOpenAIStreamIdleTimeout(stream, {
      abortAttempt: () => attemptController.abort(),
      userSignal: params.signal,
    })

    const state: CodexStreamState = {
      contentBlocks: {},
      completedBlocks: [],
    }
    const prelude: StreamEvent[] = []
    let sawTerminal = false

    for await (const event of timedStream) {
      const handled = handleCodexStreamEvent({
        event,
        partialMessage: state.partialMessage,
        contentBlocks: state.contentBlocks,
        completedBlocks: state.completedBlocks,
        start: params.start,
      })

      state.partialMessage = handled.partialMessage
      state.finalResponse = handled.finalResponse ?? state.finalResponse
      state.incompleteResponse =
        handled.incompleteResponse ?? state.incompleteResponse
      state.failedResponse = handled.failedResponse ?? state.failedResponse

      for (const out of handled.output) {
        if (out.type === 'stream_event') {
          const ev = out.event as { type?: string }
          if (ev.type === 'message_stop') sawTerminal = true
          // committed only gates REPL yield buffering. Assistant is assembled
          // at message_stop; idle/stall after text must stay retryable.
          if (
            !committed &&
            (isSemanticOpenAIEvent(out.event as BetaRawMessageStreamEvent) ||
              ev.type === 'message_stop')
          ) {
            committed = true
            if (params.emitPrimaryEvents !== false) {
              yield* prelude
            }
            prelude.length = 0
          }
        }
        if (params.emitPrimaryEvents === false) continue
        if (committed) yield out
        else prelude.push(out)
      }
    }

    let streamedResponse: Response | undefined
    try {
      streamedResponse = await stream.finalResponse()
    } catch {
      streamedResponse = undefined
    }

    if (
      !sawTerminal &&
      !state.finalResponse &&
      !state.incompleteResponse &&
      !state.failedResponse
    ) {
      throw new ProviderStreamError(
        'Codex stream ended before a terminal event',
        {
          kind: 'premature_eof',
          retryable: true,
          terminal: false,
          completionState: 'open',
        },
      )
    }

    return selectResponse(state, streamedResponse)
  } finally {
    params.signal.removeEventListener('abort', onAbort)
    attemptController.abort()
  }
}
