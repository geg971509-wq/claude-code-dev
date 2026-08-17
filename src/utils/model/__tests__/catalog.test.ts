import { describe, expect, test } from 'bun:test'
import {
  ALL_MODEL_CONFIGS,
  lookupModelCatalog,
  MODEL_CATALOG,
} from '../configs.js'

describe('MODEL_CATALOG', () => {
  test('covers every registered model config', () => {
    // 这是让"加模型只改一处"成立的不变式：ALL_MODEL_CONFIGS 里新增一个
    // 模型而忘了补 catalog 行时，canonical 归一 / UI 名 / 1M 支持 /
    // structured outputs 会一起静默失效，只有这条断言会响。
    for (const cfg of Object.values(ALL_MODEL_CONFIGS)) {
      expect(lookupModelCatalog(cfg.firstParty)?.canonical).toBeString()
    }
  })

  test('has no duplicate canonical IDs', () => {
    const ids = MODEL_CATALOG.map(e => e.canonical)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('resolves the most specific match, not the first substring hit', () => {
    // 'claude-opus-4-7' 也包含子串 'claude-opus-4'。
    expect(lookupModelCatalog('claude-opus-4-7')?.canonical).toBe(
      'claude-opus-4-7',
    )
    expect(lookupModelCatalog('claude-opus-4-20250514')?.canonical).toBe(
      'claude-opus-4',
    )
  })

  test('accepts provider-prefixed and [1m]-suffixed IDs', () => {
    expect(
      lookupModelCatalog('us.anthropic.claude-opus-4-6-v1:0')?.canonical,
    ).toBe('claude-opus-4-6')
    expect(lookupModelCatalog('claude-sonnet-4-5@20250929')?.canonical).toBe(
      'claude-sonnet-4-5',
    )
    expect(lookupModelCatalog('claude-opus-4-7[1m]')?.canonical).toBe(
      'claude-opus-4-7',
    )
  })

  test('separates native 1M from beta-gated 1M, per the official table', () => {
    // 官方 `context` 三元组：opus-4-7 是 native_1m，sonnet-4-5 只有
    // supports_1m_beta。合成一个布尔就是 sonnet-4-5 窗口被高估的根因。
    expect(lookupModelCatalog('claude-opus-4-7')?.context).toEqual({
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
    })
    expect(lookupModelCatalog('claude-sonnet-4-5')?.context).toEqual({
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
    })
    expect(lookupModelCatalog('claude-opus-4-5')?.context).toEqual({
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
    })
  })

  test('treats Claude 5 as a 4+ generation model', () => {
    // 回归守卫：老写法 `canonical.includes('claude-opus-4')` 对 opus-5 是
    // false，会把新一代静默降级成 3.x 待遇（关掉 interleaved thinking、
    // context management、vertex web search）。
    expect(lookupModelCatalog('claude-opus-5')?.generation).toBeGreaterThan(3)
    expect(lookupModelCatalog('claude-sonnet-5')?.generation).toBeGreaterThan(3)
  })

  test('returns undefined for unknown models', () => {
    expect(lookupModelCatalog('gpt-4o')).toBeUndefined()
  })
})
