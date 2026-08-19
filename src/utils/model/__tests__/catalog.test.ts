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
      supports1mSuffix: true,
    })
    expect(lookupModelCatalog('claude-sonnet-4-5')?.context).toEqual({
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
      supports1mSuffix: true,
    })
    expect(lookupModelCatalog('claude-opus-4-5')?.context).toEqual({
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: true,
    })
  })

  test('Claude 5 carries the context_management capability', () => {
    // 回归守卫：老写法 `canonical.includes('claude-opus-4')` 对 opus-5 是
    // false，会把新一代静默降级成 3.x 待遇（关掉 interleaved thinking、
    // context management、vertex web search）。现在这批门查的是官方能力。
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
      expect(lookupModelCatalog(m)?.capabilities).toContain(
        'context_management',
      )
    }
    // 3.x 一侧必须仍然为假，否则门形同虚设。
    expect(lookupModelCatalog('claude-3-5-sonnet')?.capabilities).not.toContain(
      'context_management',
    )
  })

  test('supports1mSuffix is recorded independently of the 1M window', () => {
    // 官方 supports_1m_suffix 只决定显示名后缀，与 native_1m / beta 无关：
    // sonnet-5 原生 1M 却没有 suffix，haiku-4-5 有 suffix 却没有 1M。
    expect(lookupModelCatalog('claude-sonnet-5')?.context).toMatchObject({
      native1m: true,
      supports1mSuffix: false,
    })
    expect(lookupModelCatalog('claude-haiku-4-5')?.context).toMatchObject({
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: true,
    })
  })

  test('fast_mode is recorded only where the API actually serves it', () => {
    // 官方全表只有 opus-4-8 与 opus-5 带 fast_mode。dev 曾多给 opus-4-7 记了
    // 一条 —— 而官方 bundle 明确写着 4.7 上的 `speed="fast"` 直接 API error。
    for (const m of ['claude-opus-4-8', 'claude-opus-5']) {
      expect(lookupModelCatalog(m)?.capabilities).toContain('fast_mode')
    }
    for (const m of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5']) {
      expect(lookupModelCatalog(m)?.capabilities).not.toContain('fast_mode')
    }
  })

  test('3.x rows carry no fabricated context or cutoff', () => {
    // 官方对 3.x 机型整块 `context` 和 `knowledge_cutoff` 都没写。dev 自己
    // 填过一套，其中 supports1mBeta=true 让 modelSupports1M() 对 Sonnet 3.5
    // 返回真 —— 给一个吃不下 1M 的机型挂上 1M 开关。对账器当时因为按固定
    // 窗口取值、读到了隔壁机型的 context 而报了平安。
    for (const m of ['claude-3-5-sonnet', 'claude-3-7-sonnet']) {
      expect(lookupModelCatalog(m)?.context).toEqual({
        native1m: false,
        supports1mBeta: false,
        supports1mSuffix: false,
      })
      expect(lookupModelCatalog(m)?.knowledgeCutoff).toBeUndefined()
    }
    expect(lookupModelCatalog('claude-3-5-sonnet')?.displayName).toBe(
      'Sonnet 3.5',
    )
  })

  test('returns undefined for unknown models', () => {
    expect(lookupModelCatalog('gpt-4o')).toBeUndefined()
  })
})
