import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses.mjs'
import { resolveCodexCallId } from '@ant/model-provider'

export type CodexAssistantBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: string }

function reasoningSummaryText(item: Record<string, unknown>): string {
  const summary = item.summary
  if (!Array.isArray(summary)) {
    return ''
  }

  return summary
    .map(part => {
      if (!part || typeof part !== 'object') {
        return ''
      }
      const record = part as Record<string, unknown>
      return record.type === 'summary_text' && typeof record.text === 'string'
        ? record.text
        : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function reasoningBlock(
  item: Record<string, unknown>,
): Extract<CodexAssistantBlock, { type: 'thinking' }> | null {
  const signature =
    typeof item.encrypted_content === 'string' ? item.encrypted_content : ''
  const thinking = reasoningSummaryText(item)

  if (signature.length === 0 && thinking.length === 0) {
    return null
  }

  return {
    type: 'thinking',
    thinking,
    signature,
  }
}

/**
 * Convert completed Responses output items without flattening away reasoning.
 * Codex persists the complete item sequence and replays encrypted reasoning
 * when store=false; this parser projects that sequence into the existing
 * Anthropic-style message representation used by the rest of the application.
 */
export function responseToCodexAssistantBlocks(
  response: Response,
): CodexAssistantBlock[] {
  const blocks: CodexAssistantBlock[] = []
  let hasAnswerContent = false

  for (const item of response.output) {
    if (item.type === 'reasoning') {
      const block = reasoningBlock(item as unknown as Record<string, unknown>)
      if (block) {
        blocks.push(block)
      }
      continue
    }

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
      hasAnswerContent = true
      continue
    }

    if (item.type !== 'message' || item.role !== 'assistant') {
      continue
    }

    for (const content of (item as ResponseOutputMessage).content) {
      if (content.type === 'output_text' && content.text.length > 0) {
        blocks.push({ type: 'text', text: content.text })
        hasAnswerContent = true
      } else if (content.type === 'refusal' && content.refusal.length > 0) {
        blocks.push({ type: 'text', text: content.refusal })
        hasAnswerContent = true
      }
    }
  }

  if (
    !hasAnswerContent &&
    typeof response.output_text === 'string' &&
    response.output_text.length > 0
  ) {
    blocks.push({ type: 'text', text: response.output_text })
  }

  return blocks
}
