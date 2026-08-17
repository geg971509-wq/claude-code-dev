import type { APIProvider } from './providers.js'

/**
 * 家族别名（opus / sonnet / haiku / fable）解析到哪个机型 —— 逐条来自官方
 * 配置的 `aliases` 表。
 *
 * 官方之所以要 per_provider 覆盖，是因为三方平台上线滞后：一方已经走到
 * claude-sonnet-5，Bedrock / Vertex / Foundry 上还只有 4-5。dev 此前只在
 * sonnet 上写了个 `provider !== 'firstParty'` 的粗分叉、opus 干脆两个分支
 * 返回同一个值，于是抬默认时要么把 3P 用户指向对方没有的机型，要么让一方
 * 用户永远停在旧机型。
 *
 * 官方还有 mantle / anthropic_aws / gateway 三个投放渠道，dev 没有对应的
 * provider，略去。openai / gemini / grok 是 dev 自有的兼容层，官方表里不
 * 存在，仍由各自的环境变量决定（见 model.ts 的 resolveFamilyDefaultModel）。
 */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable'

export type FamilyAliasTarget = {
  /** 官方 `default`，对应 dev 的 firstParty。值是 canonical ID。 */
  default: string
  /** 官方 `per_provider`，只保留 dev 有对应 provider 的那几家。 */
  perProvider?: Partial<Record<APIProvider, string>>
}

export const MODEL_ALIAS_TARGETS: Record<ModelFamily, FamilyAliasTarget> = {
  opus: {
    default: 'claude-opus-5',
    perProvider: {
      bedrock: 'claude-opus-5',
      vertex: 'claude-opus-5',
      foundry: 'claude-opus-4-6',
    },
  },
  sonnet: {
    default: 'claude-sonnet-5',
    perProvider: {
      bedrock: 'claude-sonnet-4-5',
      vertex: 'claude-sonnet-4-5',
      foundry: 'claude-sonnet-4-5',
    },
  },
  haiku: {
    default: 'claude-haiku-4-5',
  },
  fable: {
    default: 'claude-fable-5',
  },
}

/** 官方配置里的 `best: "fable"`。 */
export const BEST_ALIAS_FAMILY: ModelFamily = 'fable'

/** 该家族在当前 provider 下应解析到的 canonical ID。 */
export function aliasTargetCanonical(
  family: ModelFamily,
  provider: APIProvider,
): string {
  const entry = MODEL_ALIAS_TARGETS[family]
  return entry.perProvider?.[provider] ?? entry.default
}
