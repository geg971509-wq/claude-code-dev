import { describe, expect, test } from 'bun:test'
import { ASYNC_AGENT_ALLOWED_TOOLS } from '../../../constants/tools.js'
import { LIST_AGENTS_TOOL_NAME } from '../../ListAgentsTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../constants.js'
import { getPrompt } from '../prompt.js'

describe('SendMessage agent routing contract', () => {
  test('allows background agents to message the main conversation', () => {
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has(SEND_MESSAGE_TOOL_NAME)).toBe(true)
    expect(getPrompt()).toContain('`"main"`')
    expect(getPrompt()).toContain('available to background subagents')
  })

  test('forbids permission laundering through another session', () => {
    expect(getPrompt()).toContain('Permission boundaries are per session')
    expect(getPrompt()).toContain('denied or blocked in your session')
  })

  test('keeps ListAgents in the shared agent vocabulary', () => {
    expect(LIST_AGENTS_TOOL_NAME).toBe('ListAgents')
  })
})
