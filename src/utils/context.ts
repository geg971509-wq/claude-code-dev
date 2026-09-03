// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getGrokModelMetadata, resolveGrokModel } from '@ant/model-provider'
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { lookupModelCatalog, type ModelCatalogEntry } from './model/configs.js'
import { resolveAntModel } from './model/antModels.js'
import {
  CHATGPT_CODEX_MAX_OUTPUT_TOKENS,
  getChatGPTModelContextWindow,
} from './model/chatgptModels.js'
import { getModelCapability } from './model/modelCapabilities.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from './model/providers.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

/**
 * "This model can reach a 1M window" — either natively or via the
 * `context-1m` beta. Drives the `[1m]` suffix eligibility and the UI label,
 * NOT the window resolution itself (see getContextWindowForModel, which
 * distinguishes the two cases the way the official client does).
 */
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  if (getAPIProvider() === 'grok') {
    const grokMetadata = getGrokModelMetadata(resolveGrokModel(model))
    if (grokMetadata) {
      // grok-build currently declares a 500k context for grok-4.5/4.6; do
      // not inherit Claude's unrelated [1m] capability just because the UI
      // model name is Anthropic-shaped.
      return grokMetadata.contextWindow >= 1_000_000
    }
  }
  const entry = lookupModelCatalog(getCanonicalName(model))
  if (!entry) {
    return false
  }
  return entry.context.native1m || entry.context.supports1mBeta
}

/**
 * 原生 1M 是否在**当前 provider** 上成立。镜像官方的判定：`native_1m` 只在
 * 一方直连（且 base URL 确实是官方端点）时无条件成立，bedrock / vertex /
 * foundry 要逐 provider 查 `native_1m_3p`。
 *
 * dev 此前对所有 native_1m 机型无条件返回 1M —— 实测 Bedrock 上
 * opus-4-7 / 4-8 / opus-5 / fable-5 官方是 200k 而 dev 给 1M，autocompact
 * 因此迟迟不触发，最后吃真实 413。与 sonnet-4-5 那次高估是同一类错误，
 * 只是换到了 provider 这条轴上。
 *
 * openai / gemini / grok 是 dev 自有的兼容层，官方表里没有对应 provider：
 * 走到这里说明用户把一个 claude-* 机型名指到了三方端点，其 1M 能力无从判断，
 * 保持改造前的行为不做收紧。
 */
function hasNative1mHere(entry: ModelCatalogEntry | undefined): boolean {
  if (!entry?.context.native1m) {
    return false
  }
  const provider = getAPIProvider()
  if (provider === 'firstParty') {
    return isFirstPartyAnthropicBaseUrl()
  }
  if (
    provider === 'bedrock' ||
    provider === 'vertex' ||
    provider === 'foundry'
  ) {
    return entry.context.native1m3p?.[provider] === true
  }
  return true
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable (ant-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // Grok is selected through an Anthropic-facing alias, so the Claude model
  // catalog must not decide its local budgeting. grok-build's current official
  // model table is authoritative for known Grok models.
  if (getAPIProvider() === 'grok') {
    const grokMetadata = getGrokModelMetadata(resolveGrokModel(model))
    if (grokMetadata) {
      return grokMetadata.contextWindow
    }
  }

  // Branch order mirrors the official client's window resolver:
  //   [1m] suffix → context-1m beta (if the model takes it) → native 1M
  // Everything derived from a server response (ChatGPT window, capability
  // cache) is consulted only after those, so a cached `max_input_tokens`
  // reporting the model's *maximum attainable* window can no longer preempt
  // the beta check and hand a 1M budget to a session that never asked for it.
  if (has1mContext(model)) {
    return 1_000_000
  }

  const catalogEntry = lookupModelCatalog(getCanonicalName(model))
  if (
    betas?.includes(CONTEXT_1M_BETA_HEADER) &&
    catalogEntry?.context.supports1mBeta &&
    !is1mContextDisabled()
  ) {
    return 1_000_000
  }
  if (hasNative1mHere(catalogEntry) && !is1mContextDisabled()) {
    return 1_000_000
  }

  // GPT-5.6 family: OAuth/Codex ≈ 272k; API key path ≈ 1.05M (model card).
  // Used for UI %, auto-compact thresholds, and local budgeting — not sent
  // as a request field (Codex Responses does not take max_input_tokens).
  const chatgptContextWindow = getChatGPTModelContextWindow(model)
  if (chatgptContextWindow !== undefined) {
    if (
      is1mContextDisabled() &&
      chatgptContextWindow > MODEL_CONTEXT_WINDOW_DEFAULT
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return chatgptContextWindow
  }

  // Capability cache is a dev-only addition (the official client resolves the
  // window purely from its static model table). Keep it as the discovery path
  // for models the catalog has never heard of — a newly shipped model gets a
  // real window instead of the 200k default — but never let it speak for a
  // model the catalog already describes: `/v1/models` reports the *maximum
  // attainable* `max_input_tokens`, so for a beta-gated model like sonnet-4-5
  // it reads 1000000 and would reinstate exactly the over-report above.
  const cap = catalogEntry ? undefined : getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  // 官方兜底是常量 200k，不回落到 per-model 的 `context.window` —— 后者是
  // 该机型的"标称窗口"（native-1M 机型写的就是 1000000），拿它当兜底会把上面
  // 那道 provider 门控整个抵消掉：Bedrock 上 opus-4-7 明明没有原生 1M，却
  // 因为标称值是 1M 而又被判回 1M。
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  // Treat zero input tokens the same as no usage data — avoids flashing
  // "ctx:0%" when a third-party API omits usage from message_start.
  if (totalInputTokens === 0) {
    return { used: null, remaining: null }
  }

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  // GPT-5.6 family: official 128k max output (OpenAI model card).
  if (getChatGPTModelContextWindow(model) !== undefined) {
    defaultTokens = 32_000
    upperLimit = CHATGPT_CODEX_MAX_OUTPUT_TOKENS
  } else {
    // 逐条来自官方模型表的 `max_output_tokens`。此前是一条 includes 链，
    // 而 'claude-opus-4-8'.includes('opus-4') 为真 —— 新模型会静默掉进
    // opus-4-0 的 32k 分支，长回答被提前截断。
    const entry = lookupModelCatalog(getCanonicalName(model))
    defaultTokens = entry?.maxOutputTokens.default ?? MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = entry?.maxOutputTokens.upper ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
