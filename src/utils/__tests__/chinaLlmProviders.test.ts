import { describe, expect, test } from 'bun:test'
import {
  CHINA_LLM_PROVIDERS,
  findChinaProviderById,
  resolveChinaProviderBaseURL,
} from '../chinaLlmProviders.js'

describe('CHINA_LLM_PROVIDERS', () => {
  test('every provider id is unique and non-empty', () => {
    const ids = CHINA_LLM_PROVIDERS.map(p => p.id)
    expect(ids.every(id => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every model id is unique across all providers and non-empty', () => {
    const modelIds = CHINA_LLM_PROVIDERS.flatMap(p => p.models.map(m => m.id))
    expect(modelIds.length).toBeGreaterThan(0)
    expect(modelIds.every(id => id.trim().length > 0)).toBe(true)
    expect(new Set(modelIds).size).toBe(modelIds.length)
  })

  test('every baseURL is an absolute https URL', () => {
    for (const provider of CHINA_LLM_PROVIDERS) {
      expect(() => new URL(provider.baseURL)).not.toThrow()
      expect(provider.baseURL.startsWith('https://')).toBe(true)
      if (provider.codingPlan) {
        expect(() => new URL(provider.codingPlan!.baseURL)).not.toThrow()
      }
    }
  })

  test('a [1m]-tagged model id strips to a bare wire id', () => {
    // resolveOpenAIModel strips the suffix; a preset must not depend on any
    // other normalization, so the bare id has to be meaningful on its own.
    const tagged = CHINA_LLM_PROVIDERS.flatMap(p => p.models).filter(m =>
      /\[1m\]$/i.test(m.id),
    )
    for (const model of tagged) {
      const bare = model.id.replace(/\[1m\]$/i, '')
      expect(bare.length).toBeGreaterThan(0)
      expect(bare).not.toMatch(/[[\]]/)
    }
  })
})

describe('findChinaProviderById', () => {
  test('resolves the Moonshot preset', () => {
    const moonshot = findChinaProviderById('moonshot')
    expect(moonshot?.label).toBe('Moonshot Kimi')
    expect(moonshot?.baseURL).toBe('https://api.moonshot.cn/v1')
    // Kimi Code subscription: separate endpoint + OAuth device-flow sign-in.
    expect(moonshot?.codingPlan?.baseURL).toBe('https://api.kimi.com/coding/v1')
    expect(moonshot?.codingPlanOAuth).toBe(true)
    expect(moonshot?.codingPlanModels?.map(m => m.id)).toEqual([
      'kimi-for-coding',
    ])
  })

  test('exposes kimi-k3 with a 1M context opt-in', () => {
    const models = findChinaProviderById('moonshot')?.models ?? []
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('kimi-k3[1m]')
    expect(models[0]?.id.replace(/\[1m\]$/i, '')).toBe('kimi-k3')
    expect(models[0]?.contextWindow).toBe('1M')
  })

  test('returns undefined for an unknown id', () => {
    expect(findChinaProviderById('nope')).toBeUndefined()
  })
})

describe('resolveChinaProviderBaseURL', () => {
  test('returns the api base URL for Moonshot', () => {
    expect(resolveChinaProviderBaseURL('moonshot', 'api')).toBe(
      'https://api.moonshot.cn/v1',
    )
  })

  test('returns the coding-plan base URL for Moonshot', () => {
    expect(resolveChinaProviderBaseURL('moonshot', 'coding-plan')).toBe(
      'https://api.kimi.com/coding/v1',
    )
  })

  test('falls back to the api base URL when a provider has no coding plan', () => {
    const deepseek = findChinaProviderById('deepseek')
    expect(deepseek?.codingPlan).toBeUndefined()
    expect(resolveChinaProviderBaseURL('deepseek', 'coding-plan')).toBe(
      deepseek!.baseURL,
    )
  })

  test('returns the coding-plan base URL when one exists', () => {
    const zhipu = findChinaProviderById('zhipu')
    expect(zhipu?.codingPlan).toBeDefined()
    expect(resolveChinaProviderBaseURL('zhipu', 'coding-plan')).toBe(
      zhipu!.codingPlan!.baseURL,
    )
  })

  test('returns an empty string for an unknown provider', () => {
    expect(resolveChinaProviderBaseURL('nope', 'api')).toBe('')
  })
})
