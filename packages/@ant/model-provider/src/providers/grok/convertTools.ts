import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Tool as ResponsesTool } from 'openai/resources/responses/responses.mjs'

function isClientFunctionTool(tool: BetaToolUnion): tool is BetaToolUnion & {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
} {
  const value = tool as unknown as Record<string, unknown>
  const type = typeof value.type === 'string' ? value.type : undefined
  return (
    typeof value.name === 'string' &&
    type !== 'advisor_20260301' &&
    type !== 'computer_20250124' &&
    type !== 'server'
  )
}

/** Convert Claude Code client tools to the public xAI Responses function shape. */
export function anthropicToolsToGrokResponses(
  tools: BetaToolUnion[],
): ResponsesTool[] {
  return tools.flatMap(tool => {
    if (!isClientFunctionTool(tool)) return []
    return [
      {
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      } as ResponsesTool,
    ]
  })
}

/** Map Anthropic tool choice to the public Responses tool_choice shape. */
export function anthropicToolChoiceToGrokResponses(
  toolChoice: unknown,
): 'auto' | 'required' | { type: 'function'; name: string } | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined
  const value = toolChoice as Record<string, unknown>
  switch (value.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return typeof value.name === 'string'
        ? { type: 'function', name: value.name }
        : undefined
    default:
      return undefined
  }
}
