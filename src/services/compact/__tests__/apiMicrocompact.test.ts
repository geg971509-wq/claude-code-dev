import { beforeEach, afterEach, expect, test } from 'bun:test'
import { getAPIContextManagement } from '../apiMicrocompact.js'

const original = {
  clearResults: process.env.USE_API_CLEAR_TOOL_RESULTS,
  clearUses: process.env.USE_API_CLEAR_TOOL_USES,
}

beforeEach(() => {
  delete process.env.USE_API_CLEAR_TOOL_RESULTS
  delete process.env.USE_API_CLEAR_TOOL_USES
})

afterEach(() => {
  if (original.clearResults === undefined)
    delete process.env.USE_API_CLEAR_TOOL_RESULTS
  else process.env.USE_API_CLEAR_TOOL_RESULTS = original.clearResults
  if (original.clearUses === undefined)
    delete process.env.USE_API_CLEAR_TOOL_USES
  else process.env.USE_API_CLEAR_TOOL_USES = original.clearUses
})

test('preserves all thinking turns without enabling tool clearing', () => {
  expect(getAPIContextManagement({ hasThinking: true })).toEqual({
    edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
  })
})
