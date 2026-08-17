/**
 * 缓存写按 TTL 分档计价的守卫。
 *
 * 官方每个价格档都有 cache_write_5m 与 cache_write_1h 两个价（tier_5_25：
 * 6.25 / 10）。dev 此前只有一列且取的是 5m 价，而 1h TTL 是真会被请求的
 * （Bedrock + ENABLE_PROMPT_CACHING_1H_BEDROCK 这条路径不经 GrowthBook），
 * 于是 1h 场景下缓存写少算约 1.6 倍。
 *
 * 单独成文件而不是并入 modelCost.test.ts：后者刻意不 import modelCost.ts
 * （文件头注释写明「避免沉重的导入链」），只测纯格式化函数。
 */
import { describe, expect, test } from 'bun:test'
import { calculateUSDCost } from '../modelCost.js'

const MODEL = 'claude-opus-4-7' // tier_5_25：5m=6.25 / 1h=10
const MTOK = 1_000_000

function costOf(usage: Record<string, unknown>): number {
  return calculateUSDCost(MODEL, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    ...usage,
  } as never)
}

describe('cacheWriteCost', () => {
  test('1h 缓存写用 1h 单价', () => {
    expect(
      costOf({
        cache_creation_input_tokens: MTOK,
        cache_creation: {
          ephemeral_1h_input_tokens: MTOK,
          ephemeral_5m_input_tokens: 0,
        },
      }),
    ).toBeCloseTo(10, 5)
  })

  test('5m 缓存写用 5m 单价', () => {
    expect(
      costOf({
        cache_creation_input_tokens: MTOK,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: MTOK,
        },
      }),
    ).toBeCloseTo(6.25, 5)
  })

  test('两档混合时各按各的单价', () => {
    expect(
      costOf({
        cache_creation_input_tokens: MTOK,
        cache_creation: {
          ephemeral_1h_input_tokens: MTOK / 2,
          ephemeral_5m_input_tokens: MTOK / 2,
        },
      }),
    ).toBeCloseTo(5 + 3.125, 5)
  })

  test('拿不到拆分时退回 5m 单价，与改造前一致', () => {
    expect(costOf({ cache_creation_input_tokens: MTOK })).toBeCloseTo(6.25, 5)
  })
})
