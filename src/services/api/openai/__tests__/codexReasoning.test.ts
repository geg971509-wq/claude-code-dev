import { describe, expect, test } from 'bun:test'
import {
  applyCodexReasoningToRequest,
  resolveCodexResponsesReasoningEffort,
} from '../codexReasoning.js'

describe('resolveCodexResponsesReasoningEffort', () => {
  test('maps persistent to the Responses API disabled value', () => {
    expect(
      resolveCodexResponsesReasoningEffort({
        model: 'gpt-5.6-sol',
        configured: 'persistent',
        provider: 'openai',
        env: {},
      }),
    ).toBe('disabled')
  })

  test('prefers a supported multi-agent override for ultra', () => {
    expect(
      resolveCodexResponsesReasoningEffort({
        model: 'gpt-5.6-sol',
        configured: 'ultra',
        provider: 'codex',
        env: {},
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        multiAgentOverride: 'xhigh',
      }),
    ).toBe('xhigh')
  })

  test('falls back from ultra to max, then the highest supported level', () => {
    expect(
      resolveCodexResponsesReasoningEffort({
        model: 'gpt-5.6-sol',
        configured: 'ultra',
        provider: 'codex',
        env: {},
        supportedEfforts: ['low', 'medium', 'high', 'max'],
      }),
    ).toBe('max')

    expect(
      resolveCodexResponsesReasoningEffort({
        model: 'gpt-5.1',
        configured: 'ultra',
        provider: 'codex',
        env: {},
        supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
      }),
    ).toBe('xhigh')

    expect(
      resolveCodexResponsesReasoningEffort({
        model: 'custom-model',
        configured: 'ultra',
        provider: 'codex',
        env: {},
        supportedEfforts: [],
      }),
    ).toBe('medium')
  })

  test('keeps provider-specific overrides isolated', () => {
    const env = {
      OPENAI_REASONING_EFFORT: 'low',
      CODEX_REASONING_EFFORT: 'high',
    }

    expect(
      resolveCodexResponsesReasoningEffort({
        model: 'gpt-5.6-sol',
        configured: 'medium',
        provider: 'openai',
        env,
      }),
    ).toBe('low')
    expect(
      resolveCodexResponsesReasoningEffort({
        model: 'gpt-5.6-sol',
        configured: 'medium',
        provider: 'codex',
        env,
      }),
    ).toBe('high')
  })

  test('treats unset as an explicit omission', () => {
    expect(
      resolveCodexResponsesReasoningEffort({
        model: 'gpt-5.6-sol',
        configured: 'high',
        provider: 'openai',
        env: { OPENAI_REASONING_EFFORT: 'unset' },
      }),
    ).toBeUndefined()
  })
})

describe('applyCodexReasoningToRequest', () => {
  test('adds automatic summaries for ordinary reasoning levels', () => {
    const request: Record<string, unknown> = {
      reasoning: { effort: 'high' },
    }

    applyCodexReasoningToRequest(request, {
      model: 'gpt-5.6-sol',
      provider: 'openai',
      env: {},
    })

    expect(request.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  })

  test('does not request summaries when reasoning is disabled', () => {
    const request: Record<string, unknown> = {
      reasoning: { effort: 'persistent' },
    }

    applyCodexReasoningToRequest(request, {
      model: 'gpt-5.6-sol',
      provider: 'codex',
      env: {},
    })

    expect(request.reasoning).toEqual({ effort: 'disabled' })
  })
})
