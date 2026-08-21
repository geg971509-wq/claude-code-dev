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
  /**
   * 官方 `provider_ids`。openai/gemini/grok 是 dev 自有映射，等同 firstParty。
   * 除 firstParty 外都可缺省：官方对 mythos-5 就把其余各家记为 null（仅一方
   * 直连）。只有四家齐全的条目才配 `key`、才会进 ALL_MODEL_CONFIGS。
   */
  providerIds?: {
    firstParty: string
    bedrock?: string
    vertex?: string
    foundry?: string
  }
  /** 官方 `context`。整块可缺省 —— 3.x 机型官方就没有这一段。 */
  context: {
    /**
     * 官方 `context.window`：该机型的标称窗口。**没有运行时消费点** ——
     * `getContextWindowForModel` 的兜底是官方同款的 200k 常量，不是这里。
     * 留着是为了让对账器能在官方改窗口时报出来，缺省即官方没写。
     */
    window?: number
    native1m: boolean
    supports1mBeta: boolean
    /** 官方 `supports_1m_suffix`：只决定显示名是否追加 " (1M context)"。 */
    supports1mSuffix: boolean
    /**
     * 官方 `native_1m_3p`：原生 1M 在三方平台上是否也成立。
     *
     * `native_1m` 只在一方直连时无条件成立；bedrock / vertex / foundry 上
     * 官方要求这里逐 provider 为 true。缺省即三方没有原生 1M —— 官方全表
     * 只有 sonnet-5 带这个字段。
     */
    native1m3p?: { bedrock?: boolean; vertex?: boolean; foundry?: boolean }
  }
  /** 官方 `max_output_tokens`。 */
  maxOutputTokens: { default: number; upper: number }
  /** 官方 `pricing` tier 名，如 'tier_5_25'。3.0 机型官方表已不收录。 */
  pricing?: string
  /**
   * 官方 `capabilities`，原样保留。
   *
   * dev 真正**消费**的是（一律经 `modelHasCapability`，不要再写家族前缀
   * 白名单 —— 那种写法每次发新机型都会漏，effort / fast_mode /
   * adaptive_thinking 三处都是这么栽的）：
   *   effort · max_effort · xhigh_effort  → effort.ts
   *   context_management                  → betas.ts
   *   fast_mode                           → fastMode.ts
   *   adaptive_thinking                   → thinking.ts
   *   rejects_disabled_thinking           → yoloClassifier.ts
   *
   * 其余几项（mid_conv_system / lean_prompt / refusal_fallback /
   * opus_5_prompt_bundle / fable_5_mitigations）对应的是 dev 尚未实现的官方
   * 功能，只作为事实录在这里：对账器按整个数组逐字比对，漏录一项就会报出
   * 来，而实现它们的那天不必再回头翻官方 bundle。
   */
  capabilities: readonly string[]
  /** 官方 `default_effort`。缺省表示该机型没有默认 effort。 */
  defaultEffort?: string
  /**
   * 官方 `effort_cost_index`：各 effort 档相对 high(=1) 的成本倍数。
   * 只有带 `effort` 能力的机型有。
   */
  effortCostIndex?: Record<string, number>
  /** 官方 `image_limits`。 */
  imageLimits?: { maxWidth: number; maxHeight: number }
  /** 官方 `deprecation`。`remapped_to` 指向退役后应改指的机型。 */
  deprecation?: {
    retirement_dates?: Record<string, string>
    remapped_to?: string
  }
  /** 官方 `min_cli_version`。 */
  minCliVersion?: string
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
    effortCostIndex: { low: 0.67, medium: 0.76, high: 1, xhigh: 1.6, max: 1.7 },
    imageLimits: { maxWidth: 2000, maxHeight: 2000 },
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
    effortCostIndex: {
      low: 0.72,
      medium: 0.9,
      high: 1,
      xhigh: 1.65,
      max: 1.88,
    },
    imageLimits: { maxWidth: 2000, maxHeight: 2000 },
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
    ],
    defaultEffort: 'xhigh',
    imageLimits: { maxWidth: 2000, maxHeight: 2000 },
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
      supports1mBeta: true,
      supports1mSuffix: false,
      native1m3p: { bedrock: true, vertex: true, foundry: true },
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
    effortCostIndex: {
      low: 0.47,
      medium: 0.74,
      high: 1,
      xhigh: 2.41,
      max: 5.59,
    },
    imageLimits: { maxWidth: 2000, maxHeight: 2000 },
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
    displayName: 'Sonnet 3.7',
    providerIds: {
      firstParty: 'claude-3-7-sonnet-20250219',
      bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      vertex: 'claude-3-7-sonnet@20250219',
      foundry: 'claude-3-7-sonnet',
    },
    // 官方对 3.x 机型整块 `context` 都没写。dev 此前自己填了一套，其中
    // `supports_1m_beta: true` 让 modelSupports1M() 对 Sonnet 3.7 返回 true，
    // 于是 /model 会给一个根本吃不下 1M 的机型挂上 1M 开关。
    context: {
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: false,
    },
    maxOutputTokens: { default: 32_000, upper: 64_000 },
    pricing: 'tier_3_15',
    capabilities: [],
  },
  {
    key: 'sonnet35',
    canonical: 'claude-3-5-sonnet',
    displayName: 'Sonnet 3.5',
    providerIds: {
      firstParty: 'claude-3-5-sonnet-20241022',
      bedrock: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      vertex: 'claude-3-5-sonnet-v2@20241022',
      foundry: 'claude-3-5-sonnet',
    },
    context: {
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: false,
    },
    maxOutputTokens: { default: 8_192, upper: 8_192 },
    pricing: 'tier_3_15',
    capabilities: [],
  },
  {
    key: 'haiku35',
    canonical: 'claude-3-5-haiku',
    displayName: 'Haiku 3.5',
    providerIds: {
      firstParty: 'claude-3-5-haiku-20241022',
      bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      vertex: 'claude-3-5-haiku@20241022',
      foundry: 'claude-3-5-haiku',
    },
    context: {
      native1m: false,
      supports1mBeta: false,
      supports1mSuffix: false,
    },
    maxOutputTokens: { default: 8_192, upper: 8_192 },
    pricing: 'haiku_35',
    capabilities: [],
  },
  {
    key: 'fable5',
    canonical: 'claude-fable-5',
    displayName: 'Fable 5',
    knowledgeCutoff: 'January 2026',
    providerIds: {
      firstParty: 'claude-fable-5',
      bedrock: 'us.anthropic.claude-fable-5',
      vertex: 'claude-fable-5',
      foundry: 'claude-fable-5',
    },
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
      supports1mSuffix: false,
    },
    maxOutputTokens: { default: 64_000, upper: 128_000 },
    pricing: 'tier_10_50',
    capabilities: [
      'effort',
      'max_effort',
      'xhigh_effort',
      'adaptive_thinking',
      'rejects_disabled_thinking',
      'mid_conv_system',
      'context_management',
      'lean_prompt',
      'fable_5_mitigations',
      'refusal_fallback',
    ],
    defaultEffort: 'high',
    effortCostIndex: {
      low: 0.6,
      medium: 0.77,
      high: 1,
      xhigh: 1.74,
      max: 1.91,
    },
    imageLimits: { maxWidth: 2000, maxHeight: 2000 },
  },
  // mythos-5：官方 provider_ids 里除 first_party 外全是 null（仅一方直连），
  // 因此不进 ALL_MODEL_CONFIGS —— 那张表要求七家 provider ID 齐全。
  {
    canonical: 'claude-mythos-5',
    displayName: 'Mythos 5',
    knowledgeCutoff: 'January 2026',
    providerIds: { firstParty: 'claude-mythos-5' },
    context: {
      window: 1_000_000,
      native1m: true,
      supports1mBeta: true,
      supports1mSuffix: false,
    },
    maxOutputTokens: { default: 64_000, upper: 128_000 },
    pricing: 'tier_10_50',
    capabilities: [],
    imageLimits: { maxWidth: 2000, maxHeight: 2000 },
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
 * firstParty 的 ID，由映射层再做转换。codex 是 ChatGPT 订阅采样路径，
 * 按家族落到 GPT 机型，真正的解析仍走 resolveCodexModel。
 */
function codexIdFor(canonical: string): string {
  const c = canonical.toLowerCase()
  if (
    c.includes('opus-4-7') ||
    c.includes('opus-4-8') ||
    c.includes('opus-5') ||
    c.includes('fable') ||
    c.includes('mythos')
  ) {
    return 'gpt-5.5'
  }
  if (c.includes('opus')) return 'gpt-5.4'
  return 'gpt-5.4-mini'
}

function toModelConfig(entry: ModelCatalogEntry): ModelConfig {
  const ids = entry.providerIds!
  // 带 key 的条目一定四家齐全（见 providerIds 的类型注释）。
  return {
    firstParty: ids.firstParty,
    bedrock: ids.bedrock!,
    vertex: ids.vertex!,
    foundry: ids.foundry!,
    openai: ids.firstParty,
    gemini: ids.firstParty,
    grok: ids.firstParty,
    codex: codexIdFor(entry.canonical),
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
