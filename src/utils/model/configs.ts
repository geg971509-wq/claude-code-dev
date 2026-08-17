import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfig = Record<APIProvider, ModelName>

export type ModelCatalogEntry = {
  /**
   * 字段名镜像官方模型表的对象键（bundle 里标识符被 minify，对象键没有，是
   * 可确定的原始命名）：display_name / knowledge_cutoff / provider_ids /
   * context.{window,native_1m,supports_1m_beta} /
   * max_output_tokens.{default,upper} / pricing / capabilities /
   * default_effort。逐字段对账脚本因此可以直接一一比对。
   */
  /** dev 内部短键（'opus47'），ALL_MODEL_CONFIGS 的 key。3.0 机型没有。 */
  key?: string
  /** Canonical (date-stripped) ID, e.g. 'claude-opus-4-7'. */
  canonical: string
  /** 官方 `display_name`。`undefined` 表示该机型从不在 UI 里按名呈现。 */
  displayName?: string
  /** 官方 `knowledge_cutoff`，写进 system prompt 的环境段。 */
  knowledgeCutoff?: string
  /** 官方 `provider_ids`。openai/gemini/grok 是 dev 自有映射，等同 firstParty。 */
  providerIds?: {
    firstParty: string
    bedrock: string
    vertex: string
    foundry: string
  }
  /** 官方 `context`。window 是不带任何 beta 时的基础窗口。 */
  context: {
    window: number
    native1m: boolean
    supports1mBeta: boolean
    /** 官方 `supports_1m_suffix`：只决定显示名是否追加 " (1M context)"。 */
    supports1mSuffix: boolean
  }
  /** 官方 `max_output_tokens`。 */
  maxOutputTokens: { default: number; upper: number }
  /** 官方 `pricing` tier 名，如 'tier_5_25'。3.0 机型官方表已不收录。 */
  pricing?: string
  /** 官方 `capabilities` 原样保留：effort / xhigh_effort / fast_mode 等按模型门控。 */
  capabilities: readonly string[]
  /** 官方 `default_effort`。缺省表示该机型没有默认 effort。 */
  defaultEffort?: string
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
    key: 'opus50',
    canonical: 'claude-opus-5',
    displayName: 'Opus 5',
    knowledgeCutoff: 'May 2026',
    providerIds: {
      firstParty: 'claude-opus-5',
      bedrock: 'us.anthropic.claude-opus-5',
      vertex: 'claude-opus-5',
      foundry: 'claude-opus-5',
    },
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
      supports1mSuffix: true,
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
    defaultEffort: 'high',
  },
  {
    key: 'opus48',
    canonical: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    knowledgeCutoff: 'January 2026',
    providerIds: {
      firstParty: 'claude-opus-4-8',
      bedrock: 'us.anthropic.claude-opus-4-8',
      vertex: 'claude-opus-4-8',
      foundry: 'claude-opus-4-8',
    },
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
      supports1mSuffix: true,
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
    defaultEffort: 'high',
  },
  {
    key: 'opus47',
    canonical: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    knowledgeCutoff: 'January 2026',
    providerIds: {
      firstParty: 'claude-opus-4-7',
      bedrock: 'us.anthropic.claude-opus-4-7',
      vertex: 'claude-opus-4-7',
      foundry: 'claude-opus-4-7',
    },
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
      supports1mSuffix: true,
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
    defaultEffort: 'xhigh',
  },
  {
    key: 'opus46',
    canonical: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    knowledgeCutoff: 'May 2025',
    providerIds: {
      firstParty: 'claude-opus-4-6',
      bedrock: 'us.anthropic.claude-opus-4-6-v1',
      vertex: 'claude-opus-4-6',
      foundry: 'claude-opus-4-6',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 64_000, upper: 128_000 },
    pricing: 'tier_5_25',
    capabilities: [
      'effort',
      'max_effort',
      'adaptive_thinking',
      'context_management',
    ],
    defaultEffort: 'xhigh',
  },
  {
    key: 'opus45',
    canonical: 'claude-opus-4-5',
    displayName: 'Opus 4.5',
    knowledgeCutoff: 'May 2025',
    providerIds: {
      firstParty: 'claude-opus-4-5-20251101',
      bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
      vertex: 'claude-opus-4-5@20251101',
      foundry: 'claude-opus-4-5',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_5_25',
    capabilities: ['context_management'],
  },
  {
    key: 'opus41',
    canonical: 'claude-opus-4-1',
    displayName: 'Opus 4.1',
    knowledgeCutoff: 'January 2025',
    providerIds: {
      firstParty: 'claude-opus-4-1-20250805',
      bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
      vertex: 'claude-opus-4-1@20250805',
      foundry: 'claude-opus-4-1',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 32_000, upper: 32_000 },
    pricing: 'tier_15_75',
    capabilities: ['context_management'],
  },
  {
    key: 'opus40',
    canonical: 'claude-opus-4',
    displayName: 'Opus 4',
    knowledgeCutoff: 'January 2025',
    providerIds: {
      firstParty: 'claude-opus-4-20250514',
      bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
      vertex: 'claude-opus-4@20250514',
      foundry: 'claude-opus-4',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 32_000, upper: 32_000 },
    pricing: 'tier_15_75',
    capabilities: ['context_management'],
  },
  {
    key: 'sonnet50',
    canonical: 'claude-sonnet-5',
    displayName: 'Sonnet 5',
    knowledgeCutoff: 'January 2026',
    providerIds: {
      firstParty: 'claude-sonnet-5',
      bedrock: 'us.anthropic.claude-sonnet-5',
      vertex: 'claude-sonnet-5',
      foundry: 'claude-sonnet-5',
    },
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: false,
      supports1mSuffix: false,
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
    defaultEffort: 'high',
  },
  {
    key: 'sonnet46',
    canonical: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    knowledgeCutoff: 'August 2025',
    providerIds: {
      firstParty: 'claude-sonnet-4-6',
      bedrock: 'us.anthropic.claude-sonnet-4-6',
      vertex: 'claude-sonnet-4-6',
      foundry: 'claude-sonnet-4-6',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 32_000, upper: 128_000 },
    pricing: 'tier_3_15',
    capabilities: [
      'effort',
      'max_effort',
      'adaptive_thinking',
      'context_management',
    ],
    defaultEffort: 'high',
  },
  {
    key: 'sonnet45',
    canonical: 'claude-sonnet-4-5',
    displayName: 'Sonnet 4.5',
    knowledgeCutoff: 'January 2025',
    providerIds: {
      firstParty: 'claude-sonnet-4-5-20250929',
      bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      vertex: 'claude-sonnet-4-5@20250929',
      foundry: 'claude-sonnet-4-5',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_3_15',
    capabilities: ['context_management'],
  },
  {
    key: 'sonnet40',
    canonical: 'claude-sonnet-4',
    displayName: 'Sonnet 4',
    knowledgeCutoff: 'January 2025',
    providerIds: {
      firstParty: 'claude-sonnet-4-20250514',
      bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      vertex: 'claude-sonnet-4@20250514',
      foundry: 'claude-sonnet-4',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_3_15',
    capabilities: ['context_management'],
  },
  {
    key: 'haiku45',
    canonical: 'claude-haiku-4-5',
    displayName: 'Haiku 4.5',
    knowledgeCutoff: 'February 2025',
    providerIds: {
      firstParty: 'claude-haiku-4-5-20251001',
      bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      vertex: 'claude-haiku-4-5@20251001',
      foundry: 'claude-haiku-4-5',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'haiku_45',
    capabilities: ['context_management'],
  },
  {
    key: 'sonnet37',
    canonical: 'claude-3-7-sonnet',
    displayName: 'Claude 3.7 Sonnet',
    knowledgeCutoff: 'January 2025',
    providerIds: {
      firstParty: 'claude-3-7-sonnet-20250219',
      bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      vertex: 'claude-3-7-sonnet@20250219',
      foundry: 'claude-3-7-sonnet',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_3_15',
    capabilities: [],
  },
  {
    key: 'sonnet35',
    canonical: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    knowledgeCutoff: 'January 2025',
    providerIds: {
      firstParty: 'claude-3-5-sonnet-20241022',
      bedrock: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      vertex: 'claude-3-5-sonnet-v2@20241022',
      foundry: 'claude-3-5-sonnet',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: true,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 8_192, upper: 8_192 },
    pricing: 'tier_3_15',
    capabilities: [],
  },
  {
    key: 'haiku35',
    canonical: 'claude-3-5-haiku',
    displayName: 'Claude 3.5 Haiku',
    knowledgeCutoff: 'February 2025',
    providerIds: {
      firstParty: 'claude-3-5-haiku-20241022',
      bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      vertex: 'claude-3-5-haiku@20241022',
      foundry: 'claude-3-5-haiku',
    },
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: true,
    },
    maxOutputTokens: { default: 8_192, upper: 8_192 },
    pricing: 'haiku_35',
    capabilities: [],
  },
  // 3.0 机型：官方表已不再收录，只用于 canonical 归一，UI 从不呈现。
  {
    canonical: 'claude-3-opus',
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: false,
    },
    maxOutputTokens: { default: 4_096, upper: 4_096 },
    capabilities: [],
  },
  {
    canonical: 'claude-3-sonnet',
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: false,
    },
    maxOutputTokens: { default: 8_192, upper: 8_192 },
    capabilities: [],
  },
  {
    canonical: 'claude-3-haiku',
    context: {
      window: 200_000,
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: false,
    },
    maxOutputTokens: { default: 4_096, upper: 4_096 },
    capabilities: [],
  },
]

/**
 * provider 各家的模型 ID 由 MODEL_CATALOG 的 `providerIds` 派生 —— 官方把它
 * 记在同一行对象的 `provider_ids` 里，dev 此前另立一张表，加模型要改两处，
 * 而"只改了一处"正是 1M 判定、输出上限、知识截止那几个缺陷的共同成因。
 *
 * openai / gemini / grok 是 dev 自有的兼容层，官方没有对应项；它们沿用
 * firstParty 的 ID，由映射层再做转换。
 */
function toModelConfig(entry: ModelCatalogEntry): ModelConfig {
  const ids = entry.providerIds!
  return {
    firstParty: ids.firstParty,
    bedrock: ids.bedrock,
    vertex: ids.vertex,
    foundry: ids.foundry,
    openai: ids.firstParty,
    gemini: ids.firstParty,
    grok: ids.firstParty,
  }
}

export const ALL_MODEL_CONFIGS = Object.fromEntries(
  MODEL_CATALOG.filter(e => e.key !== undefined).map(e => [
    e.key!,
    toModelConfig(e),
  ]),
) as Record<string, ModelConfig>

/** 少数调用方按名引用单个 config。 */
export const CLAUDE_OPUS_4_6_CONFIG = ALL_MODEL_CONFIGS.opus46!
export const CLAUDE_OPUS_4_7_CONFIG = ALL_MODEL_CONFIGS.opus47!

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
