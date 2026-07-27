import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { resolveOpenAIModel } from '../modelMapping.js'

describe('resolveOpenAIModel', () => {
  const originalEnv = {
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_DEFAULT_HAIKU_MODEL: process.env.OPENAI_DEFAULT_HAIKU_MODEL,
    OPENAI_DEFAULT_SONNET_MODEL: process.env.OPENAI_DEFAULT_SONNET_MODEL,
    OPENAI_DEFAULT_OPUS_MODEL: process.env.OPENAI_DEFAULT_OPUS_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  }

  beforeEach(() => {
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_DEFAULT_HAIKU_MODEL
    delete process.env.OPENAI_DEFAULT_SONNET_MODEL
    delete process.env.OPENAI_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  })

  afterEach(() => {
    Object.assign(process.env, originalEnv)
  })

  test('OPENAI_MODEL env var overrides all', () => {
    process.env.OPENAI_MODEL = 'my-custom-model'
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('my-custom-model')
  })

  test('ANTHROPIC_DEFAULT_SONNET_MODEL overrides default map', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'my-sonnet'
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('my-sonnet')
  })

  test('ANTHROPIC_DEFAULT_HAIKU_MODEL overrides default map', () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'my-haiku'
    expect(resolveOpenAIModel('claude-haiku-4-5-20251001')).toBe('my-haiku')
  })

  test('ANTHROPIC_DEFAULT_OPUS_MODEL overrides default map', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'my-opus'
    expect(resolveOpenAIModel('claude-opus-4-6')).toBe('my-opus')
  })

  test('maps known Anthropic model via DEFAULT_MODEL_MAP', () => {
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('gpt-4o')
  })

  test('maps haiku model', () => {
    expect(resolveOpenAIModel('claude-haiku-4-5-20251001')).toBe('gpt-4o-mini')
  })

  test('maps opus model', () => {
    expect(resolveOpenAIModel('claude-opus-4-6')).toBe('o3')
  })

  test('passes through unknown model name', () => {
    expect(resolveOpenAIModel('some-random-model')).toBe('some-random-model')
  })

  test('strips [1m] suffix', () => {
    expect(resolveOpenAIModel('claude-sonnet-4-6[1m]')).toBe('gpt-4o')
  })

  test('strips [1m] suffix from an OPENAI_DEFAULT_*_MODEL override', () => {
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'kimi-k3[1m]'
    // The /model picker resolves a custom 3P model to the bare 'sonnet' alias,
    // so the override is what reaches the wire — it must not carry [1m].
    expect(resolveOpenAIModel('sonnet')).toBe('kimi-k3')
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('kimi-k3')
  })

  test('strips [1m] suffix from an ANTHROPIC_DEFAULT_*_MODEL override', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'kimi-k3[1m]'
    expect(resolveOpenAIModel('claude-opus-4-6')).toBe('kimi-k3')
  })

  test('strips [1m] suffix from OPENAI_MODEL', () => {
    process.env.OPENAI_MODEL = 'kimi-k3[1m]'
    expect(resolveOpenAIModel('claude-sonnet-4-6')).toBe('kimi-k3')
  })

  test('leaves a [1m]-tagged session model resolving to the bare id', () => {
    expect(resolveOpenAIModel('kimi-k3[1m]')).toBe('kimi-k3')
  })
})
