// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { modelHasCapability } from './model/configs.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getAPIProvider } from './model/providers.js'
import { getSettingsWithErrors } from './settings/settings.js'
import { resolveAntModel } from './model/antModels.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (GrowthBook). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

// TODO(inigo): add support for probing unknown models via API error detection
// Provider-aware thinking support detection (aligns with modelSupportsISP in betas.ts)
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) {
      return true
    }
  }
  // IMPORTANT: Do not change thinking support without notifying the model
  // launch DRI and research. This can greatly affect model quality and bashing.
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 1P and Foundry: all Claude 4+ models (including Haiku 4.5)
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  // 3P (Bedrock/Vertex): only Opus 4+ and Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}

export type ThinkingType = 'enabled' | 'adaptive'

/**
 * 服务端拒绝某个 `thinking.type` 之后，对该机型改判的结果。
 *
 * 触发场景是模型表判断不了的部署差异 —— 最典型的是 Bedrock 的
 * application-inference-profile：机型本身支持 adaptive，那个部署却只认
 * `enabled`。此前这类 400 直接终止回合，用户没有任何可操作的出路（模型表
 * 说支持，服务端说不支持，两边都不肯让步）。现在由 withRetry 分类后写进
 * 这里并重发一次。进程级，与 betaLedger 同一取向。
 */
const thinkingTypeOverrides = new Map<string, ThinkingType>()

export function setThinkingTypeOverride(
  model: string,
  type: ThinkingType,
): void {
  thinkingTypeOverrides.set(getCanonicalName(model), type)
}

export function getThinkingTypeOverride(
  model: string,
): ThinkingType | undefined {
  return thinkingTypeOverrides.get(getCanonicalName(model))
}

/** 测试用 —— 覆盖表是模块级的。 */
export function resetThinkingTypeOverrides(): void {
  thinkingTypeOverrides.clear()
}

export function modelSupportsAdaptiveThinking(model: string): boolean {
  // 服务端的实测结论优先于模型表的静态判断。
  const override = getThinkingTypeOverride(model)
  if (override !== undefined) {
    return override === 'adaptive'
  }
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // 按模型表的 `adaptive_thinking` 能力门控，不是家族前缀白名单。
  //
  // 前缀白名单曾是 `opus-4-7 || opus-4-6 || sonnet-4-6`，而下面那道 legacy
  // 排除又是裸的 `includes('opus')` —— 于是 opus-4-8 / opus-5 / sonnet-5 三个
  // 明明带 adaptive_thinking 的机型全部落进 `return false`，被静默降级。
  // effort.ts 已经因为同一个原因改过一次（见那里的注释），这里当时漏了。
  if (modelHasCapability(canonical, 'adaptive_thinking')) {
    return true
  }
  // Exclude any other known legacy models (allowlist above catches 4-6+ variants first)
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // IMPORTANT: Do not change adaptive thinking support without notifying the
  // model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Newer models (4.6+) are all trained on adaptive thinking and MUST have it
  // enabled for model testing. DO NOT default to false for first party, otherwise
  // we may silently degrade model quality.

  // Default to true for unknown model strings on 1P and Foundry (because Foundry
  // is a proxy). Do not default to true for other 3P as they have different formats
  // for their model strings.
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}
