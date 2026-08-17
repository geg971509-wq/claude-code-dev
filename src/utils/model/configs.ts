import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfig = Record<APIProvider, ModelName>

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
  openai: 'claude-3-7-sonnet-20250219',
  gemini: 'claude-3-7-sonnet-20250219',
  grok: 'claude-3-7-sonnet-20250219',
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
  openai: 'claude-3-5-sonnet-20241022',
  gemini: 'claude-3-5-sonnet-20241022',
  grok: 'claude-3-5-sonnet-20241022',
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
  openai: 'claude-3-5-haiku-20241022',
  gemini: 'claude-3-5-haiku-20241022',
  grok: 'claude-3-5-haiku-20241022',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
  openai: 'claude-haiku-4-5-20251001',
  gemini: 'claude-haiku-4-5-20251001',
  grok: 'claude-haiku-4-5-20251001',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
  openai: 'claude-sonnet-4-20250514',
  gemini: 'claude-sonnet-4-20250514',
  grok: 'claude-sonnet-4-20250514',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
  openai: 'claude-sonnet-4-5-20250929',
  gemini: 'claude-sonnet-4-5-20250929',
  grok: 'claude-sonnet-4-5-20250929',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
  openai: 'claude-opus-4-20250514',
  gemini: 'claude-opus-4-20250514',
  grok: 'claude-opus-4-20250514',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
  openai: 'claude-opus-4-1-20250805',
  gemini: 'claude-opus-4-1-20250805',
  grok: 'claude-opus-4-1-20250805',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
  openai: 'claude-opus-4-5-20251101',
  gemini: 'claude-opus-4-5-20251101',
  grok: 'claude-opus-4-5-20251101',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
  openai: 'claude-opus-4-6',
  gemini: 'claude-opus-4-6',
  grok: 'claude-opus-4-6',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_7_CONFIG = {
  firstParty: 'claude-opus-4-7',
  // No `-v1` suffix — verified against the official bundle, which carries
  // `us.anthropic.claude-opus-4-7` (4.6 is the last one with `-v1`).
  bedrock: 'us.anthropic.claude-opus-4-7',
  vertex: 'claude-opus-4-7',
  foundry: 'claude-opus-4-7',
  openai: 'claude-opus-4-7',
  gemini: 'claude-opus-4-7',
  grok: 'claude-opus-4-7',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_8_CONFIG = {
  firstParty: 'claude-opus-4-8',
  bedrock: 'us.anthropic.claude-opus-4-8',
  vertex: 'claude-opus-4-8',
  foundry: 'claude-opus-4-8',
  openai: 'claude-opus-4-8',
  gemini: 'claude-opus-4-8',
  grok: 'claude-opus-4-8',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_5_CONFIG = {
  firstParty: 'claude-opus-5',
  bedrock: 'us.anthropic.claude-opus-5',
  vertex: 'claude-opus-5',
  foundry: 'claude-opus-5',
  openai: 'claude-opus-5',
  gemini: 'claude-opus-5',
  grok: 'claude-opus-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_5_CONFIG = {
  firstParty: 'claude-sonnet-5',
  bedrock: 'us.anthropic.claude-sonnet-5',
  vertex: 'claude-sonnet-5',
  foundry: 'claude-sonnet-5',
  openai: 'claude-sonnet-5',
  gemini: 'claude-sonnet-5',
  grok: 'claude-sonnet-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
  openai: 'claude-sonnet-4-6',
  gemini: 'claude-sonnet-4-6',
  grok: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  sonnet50: CLAUDE_SONNET_5_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
  opus47: CLAUDE_OPUS_4_7_CONFIG,
  opus48: CLAUDE_OPUS_4_8_CONFIG,
  opus50: CLAUDE_OPUS_5_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>

export type ModelCatalogEntry = {
  /** Canonical (date-stripped) ID, e.g. 'claude-opus-4-7'. */
  canonical: string
  /**
   * 字段名镜像官方模型表的对象键（bundle 里标识符被 minify，对象键没有，
   * 是可确定的原始命名）：display_name / context.{window,native_1m,
   * supports_1m_beta} / max_output_tokens.{default,upper} / pricing /
   * capabilities。逐字段对账脚本因此可以直接一一比对。
   */
  /** 官方 `display_name`。`undefined` 表示该机型从不在 UI 里按名呈现。 */
  displayName?: string
  /** dev 自有字段（官方用 `family`）。"Claude 4+" 类能力门测 `generation >= 4`。 */
  generation: number
  /** 官方 `context`。window 是不带任何 beta 时的基础窗口。 */
  context: { window: number; native1m: boolean; supports1mBeta: boolean }
  /** 官方 `max_output_tokens`。 */
  maxOutputTokens: { default: number; upper: number }
  /** 官方 `pricing` tier 名，如 'tier_5_25'。3.0 机型官方表已不收录。 */
  pricing?: string
  /** 官方 `capabilities` 原样保留：effort / xhigh_effort / fast_mode 等按模型门控。 */
  capabilities: readonly string[]
}

/**
 * 每个模型一行的事实表 —— 加模型只改这里。
 *
 * 在此之前，同一份事实散在四条 `canonical.includes('claude-opus-4-7')` 的
 * if 链里（canonical 归一、UI 名、1M 支持、structured outputs），每条都靠
 * "长的写在前面"的书写顺序才正确。新模型漏改任何一条都不会报错，只会静默
 * 落到错误分支 —— `claude-opus-5` 尤其危险：它不含子串 `claude-opus-4`，
 * 会让所有"Claude 4+"的能力门直接判成 false。这里改用 generation 字段 +
 * 最长匹配查表，两个坑一起堵掉。
 *
 * 顺序不影响正确性（查表按 canonical 长度降序），只影响可读性。
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    canonical: 'claude-opus-5',
    displayName: 'Opus 5',
    generation: 5,
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 64_000, upper: 128_000 },
    pricing: 'tier_5_25',
    capabilities: [
      'effort',
      'max_effort',
      'xhigh_effort',
      'adaptive_thinking',
      'mid_conv_system',
      'context_management',
      'fast_mode',
      'lean_prompt',
      'refusal_fallback',
      'opus_5_prompt_bundle',
    ],
  },
  {
    canonical: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    generation: 4,
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 64_000, upper: 128_000 },
    pricing: 'tier_5_25',
    capabilities: [
      'effort',
      'max_effort',
      'xhigh_effort',
      'adaptive_thinking',
      'mid_conv_system',
      'context_management',
      'fast_mode',
      'lean_prompt',
    ],
  },
  {
    canonical: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    generation: 4,
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 64_000, upper: 128_000 },
    pricing: 'tier_5_25',
    capabilities: [
      'effort',
      'max_effort',
      'xhigh_effort',
      'adaptive_thinking',
      'context_management',
      'fast_mode',
    ],
  },
  {
    canonical: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    generation: 4,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 64_000, upper: 128_000 },
    pricing: 'tier_5_25',
    capabilities: [
      'effort',
      'max_effort',
      'adaptive_thinking',
      'context_management',
    ],
  },
  {
    canonical: 'claude-opus-4-5',
    displayName: 'Opus 4.5',
    generation: 4,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_5_25',
    capabilities: ['context_management'],
  },
  {
    canonical: 'claude-opus-4-1',
    displayName: 'Opus 4.1',
    generation: 4,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
    },
    maxOutputTokens: { default: 32_000, upper: 32_000 },
    pricing: 'tier_15_75',
    capabilities: ['context_management'],
  },
  {
    canonical: 'claude-opus-4',
    displayName: 'Opus 4',
    generation: 4,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
    },
    maxOutputTokens: { default: 32_000, upper: 32_000 },
    pricing: 'tier_15_75',
    capabilities: ['context_management'],
  },
  {
    canonical: 'claude-sonnet-5',
    displayName: 'Sonnet 5',
    generation: 5,
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: false,
    },
    maxOutputTokens: { default: 64_000, upper: 128_000 },
    pricing: 'tier_3_15',
    capabilities: [
      'effort',
      'max_effort',
      'xhigh_effort',
      'adaptive_thinking',
      'mid_conv_system',
      'context_management',
    ],
  },
  {
    canonical: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    generation: 4,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 32_000, upper: 128_000 },
    pricing: 'tier_3_15',
    capabilities: [
      'effort',
      'max_effort',
      'adaptive_thinking',
      'context_management',
    ],
  },
  {
    canonical: 'claude-sonnet-4-5',
    displayName: 'Sonnet 4.5',
    generation: 4,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_3_15',
    capabilities: ['context_management'],
  },
  {
    canonical: 'claude-sonnet-4',
    displayName: 'Sonnet 4',
    generation: 4,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_3_15',
    capabilities: ['context_management'],
  },
  {
    canonical: 'claude-haiku-4-5',
    displayName: 'Haiku 4.5',
    generation: 4,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'haiku_45',
    capabilities: ['context_management'],
  },
  {
    canonical: 'claude-3-7-sonnet',
    displayName: 'Claude 3.7 Sonnet',
    generation: 3,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_3_15',
    capabilities: [],
  },
  {
    canonical: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    generation: 3,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
    },
    maxOutputTokens: { default: 8_192, upper: 8_192 },
    pricing: 'tier_3_15',
    capabilities: [],
  },
  {
    canonical: 'claude-3-5-haiku',
    displayName: 'Claude 3.5 Haiku',
    generation: 3,
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
    },
    maxOutputTokens: { default: 8_192, upper: 8_192 },
    pricing: 'haiku_35',
    capabilities: [],
  },
  // 3.0 机型：官方表已不再收录，只用于 canonical 归一，UI 从不呈现。
  {
    canonical: 'claude-3-opus',
    generation: 3,
    context: { window: 200_000, native1m: false, supports1mBeta: false },
    maxOutputTokens: { default: 4_096, upper: 4_096 },
    capabilities: [],
  },
  {
    canonical: 'claude-3-sonnet',
    generation: 3,
    context: { window: 200_000, native1m: false, supports1mBeta: false },
    maxOutputTokens: { default: 8_192, upper: 8_192 },
    capabilities: [],
  },
  {
    canonical: 'claude-3-haiku',
    generation: 3,
    context: { window: 200_000, native1m: false, supports1mBeta: false },
    maxOutputTokens: { default: 4_096, upper: 4_096 },
    capabilities: [],
  },
]

/** Longest canonical first, so 'claude-opus-4-7' wins over 'claude-opus-4'. */
const CATALOG_BY_SPECIFICITY = [...MODEL_CATALOG].sort(
  (a, b) => b.canonical.length - a.canonical.length,
)

/**
 * Find the catalog row for any model string — accepts full provider IDs
 * ('us.anthropic.claude-opus-4-6-v1:0'), canonical IDs, and `[1m]` suffixes.
 */
export function lookupModelCatalog(
  model: string,
): ModelCatalogEntry | undefined {
  const needle = model.toLowerCase()
  return CATALOG_BY_SPECIFICITY.find(e => needle.includes(e.canonical))
}

/** 官方 `capabilities` 数组的按模型查询。 */
export function modelHasCapability(model: string, capability: string): boolean {
  return lookupModelCatalog(model)?.capabilities.includes(capability) ?? false
}
