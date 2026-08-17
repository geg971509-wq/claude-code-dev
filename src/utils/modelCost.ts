import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import { MODEL_CATALOG } from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  /** 官方 `cache_write_5m`。 */
  promptCacheWriteTokens: number
  /** 官方 `cache_write_1h`。1h TTL 的缓存写单价更高（约 1.6 倍）。 */
  promptCacheWrite1hTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

// Standard pricing tier for Sonnet models: $3 input / $15 output per Mtok
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheWrite1hTokens: 6,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4/4.1: $15 input / $75 output per Mtok
export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheWrite1hTokens: 30,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4.5: $5 input / $25 output per Mtok
export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheWrite1hTokens: 10,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// 官方 pricing tier "tier_10_50"（fable-5 / mythos-5）：$10 输入 / $50 输出。
// 缓存倍率沿用本文件所有档位一致的关系：write = input × 1.25、read = input × 0.1。
export const COST_TIER_10_50 = {
  inputTokens: 10,
  outputTokens: 50,
  promptCacheWriteTokens: 12.5,
  promptCacheWrite1hTokens: 20,
  promptCacheReadTokens: 1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Fast mode pricing for Opus 4.6: $30 input / $150 output per Mtok
export const COST_TIER_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  // 官方没有这一档（30/150 是 dev 本地产物），1h 价按官方各档一致的
  // cache_write_1h = input × 2 关系给出。
  promptCacheWrite1hTokens: 60,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 3.5: $0.80 input / $4 output per Mtok
export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheWrite1hTokens: 1.6,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 4.5: $1 input / $5 output per Mtok
export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheWrite1hTokens: 2,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25

/**
 * Get the cost tier for Opus 4.6 based on fast mode.
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}

// Costs from https://platform.claude.com/docs/en/about-claude/pricing
// Web search cost: $10 per 1000 requests = $0.01 per request
//
// 官方 `pricing` tier 名 → 本文件的常量。加模型只需在 MODEL_CATALOG 里写下
// 官方那个 tier 名，这里不必再动。
const COSTS_BY_PRICING_TIER: Record<string, ModelCosts> = {
  tier_3_15: COST_TIER_3_15,
  tier_5_25: COST_TIER_5_25,
  tier_15_75: COST_TIER_15_75,
  tier_10_50: COST_TIER_10_50,
  haiku_35: COST_HAIKU_35,
  haiku_45: COST_HAIKU_45,
}

/** 由 MODEL_CATALOG 的 `pricing` 派生，不再逐个模型手写一行。 */
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> =
  Object.fromEntries(
    MODEL_CATALOG.flatMap(entry => {
      const costs = entry.pricing && COSTS_BY_PRICING_TIER[entry.pricing]
      return costs ? [[entry.canonical, costs] as const] : []
    }),
  )

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
/**
 * 缓存写按 TTL 分档计价。官方每个价格档都有 cache_write_5m 与 cache_write_1h
 * 两个价（如 tier_5_25：6.25 / 10），dev 此前只有一列且取的是 5m 价 —— 而
 * dev 确实会请求 1h TTL（Bedrock + ENABLE_PROMPT_CACHING_1H_BEDROCK 这条路径
 * 不经 GrowthBook），于是 1h 场景下缓存写少算约 1.6 倍。
 *
 * 回包里的 `cache_creation` 带 ephemeral_1h / ephemeral_5m 拆分；拿不到拆分时
 * 退回按 5m 计，与改造前行为一致。
 */
function cacheWriteCost(modelCosts: ModelCosts, usage: Usage): number {
  const breakdown = usage.cache_creation
  if (breakdown) {
    return (
      (breakdown.ephemeral_5m_input_tokens / 1_000_000) *
        modelCosts.promptCacheWriteTokens +
      (breakdown.ephemeral_1h_input_tokens / 1_000_000) *
        modelCosts.promptCacheWrite1hTokens
    )
  }
  return (
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
    modelCosts.promptCacheWriteTokens
  )
}

function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    cacheWriteCost(modelCosts, usage) +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const shortName = getCanonicalName(model)

  // Fast-mode pricing. 与官方的分歧，刻意保留原状：官方模型表把 `fast_mode`
  // 记在 opus-4-7 / 4-8 / opus-5 上（4-6 没有），且全表只有一个
  // `pricing: "tier_5_25"`，不存在 30/150 这一档 —— 30/150 是 dev 本地的
  // 产物。没有官方依据可以据以扩展到别的机型，因此不动。
  if (shortName === 'claude-opus-4-6') {
    const isFastMode = usage.speed === 'fast'
    return getOpus46CostTier(isFastMode)
  }

  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    trackUnknownModelCost(model, shortName)
    return (
      MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
      DEFAULT_UNKNOWN_MODEL_COST
    )
  }
  return costs
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
