import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getGrokModelMetadata,
  normalizeGrokReasoningEffort,
  resolveGrokApiBackend,
  resolveGrokModel,
} from '../modelMapping.js'

describe('Grok official model resolution', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.GROK_MODEL
    delete process.env.GROK_MODEL_MAP
    delete process.env.GROK_API_BACKEND
    delete process.env.GROK_DEFAULT_SONNET_MODEL
    delete process.env.GROK_DEFAULT_OPUS_MODEL
    delete process.env.GROK_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('GROK_MODEL env var takes highest priority', () => {
    process.env.GROK_MODEL = 'grok-custom'
    expect(resolveGrokModel('claude-sonnet-4-6')).toBe('grok-custom')
  })

  test('maps all Claude-facing families to the official grok-4.6 default', () => {
    expect(resolveGrokModel('claude-opus-4-6')).toBe('grok-4.6')
    expect(resolveGrokModel('claude-sonnet-4-6')).toBe('grok-4.6')
    expect(resolveGrokModel('claude-haiku-4-5-20251001')).toBe('grok-4.6')
  })

  test('GROK_MODEL_MAP overrides family mapping', () => {
    process.env.GROK_MODEL_MAP =
      '{"opus":"grok-4.5","sonnet":"grok-4.6","haiku":"grok-mini"}'
    expect(resolveGrokModel('claude-opus-4-6')).toBe('grok-4.5')
    expect(resolveGrokModel('claude-sonnet-4-6')).toBe('grok-4.6')
    expect(resolveGrokModel('claude-haiku-4-5-20251001')).toBe('grok-mini')
  })

  test('GROK_MODEL_MAP ignores invalid JSON', () => {
    process.env.GROK_MODEL_MAP = 'not-json'
    expect(resolveGrokModel('claude-opus-4-6')).toBe('grok-4.6')
  })

  test('GROK_DEFAULT_{FAMILY}_MODEL overrides official default', () => {
    process.env.GROK_DEFAULT_OPUS_MODEL = 'grok-4.5'
    expect(resolveGrokModel('claude-opus-4-6')).toBe('grok-4.5')
  })

  test('passes through unknown model names for compatible custom endpoints', () => {
    expect(resolveGrokModel('some-unknown-model')).toBe('some-unknown-model')
  })

  test('strips [1m] suffix before lookup', () => {
    expect(resolveGrokModel('claude-sonnet-4-6[1m]')).toBe('grok-4.6')
  })

  test('falls back to grok-4.6 for an unlisted Claude family model', () => {
    expect(resolveGrokModel('claude-opus-99-20300101')).toBe('grok-4.6')
  })

  test('official grok-4.6 metadata matches grok-build catalog', () => {
    expect(getGrokModelMetadata('grok-4.6')).toEqual({
      contextWindow: 500_000,
      apiBackend: 'responses',
      supportsBackendSearch: true,
      supportsReasoningEffort: true,
      defaultReasoningEffort: 'high',
      reasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
    })
  })

  test('official grok-4.5 uses Responses but does not expose xhigh', () => {
    expect(getGrokModelMetadata('grok-4.5')).toMatchObject({
      contextWindow: 500_000,
      apiBackend: 'responses',
      supportsBackendSearch: false,
      reasoningEfforts: ['high', 'medium', 'low'],
    })
  })

  test('official models select Responses while unknown models preserve chat compatibility', () => {
    expect(resolveGrokApiBackend('grok-4.6')).toBe('responses')
    expect(resolveGrokApiBackend('grok-4.5')).toBe('responses')
    expect(resolveGrokApiBackend('grok-legacy')).toBe('chat_completions')
  })

  test('GROK_API_BACKEND can explicitly select any official transport shape', () => {
    process.env.GROK_API_BACKEND = 'messages'
    expect(resolveGrokApiBackend('grok-4.6')).toBe('messages')
    process.env.GROK_API_BACKEND = 'chat-completions'
    expect(resolveGrokApiBackend('grok-4.6')).toBe('chat_completions')
  })

  test('effort is clamped to the selected official model', () => {
    expect(normalizeGrokReasoningEffort('grok-4.6', undefined)).toBe('high')
    expect(normalizeGrokReasoningEffort('grok-4.6', 'max')).toBe('xhigh')
    expect(normalizeGrokReasoningEffort('grok-4.5', 'xhigh')).toBe('high')
    expect(normalizeGrokReasoningEffort('grok-4.5', 'low')).toBe('low')
  })
})
