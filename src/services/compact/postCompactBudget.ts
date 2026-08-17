import {
  PRESERVE_RECENT_MIN_TOKENS,
  preserveRecentBudget,
} from './tailPreservation.js'

/**
 * 压缩后逐字保留内容的统一预算仲裁点。
 *
 * 在此之前 compact 有两条独立的"保留原文"策略，各自读自己的常量、互不知情：
 *   - tail preservation（最近 N 个 API round 逐字保留）：25% 窗口，夹取 [2k, 8k]
 *   - preserved user messages（真实用户消息 HEAD+TAIL）：固定上限 8k
 * 两者相加最多 16k，且这个和从来没有和上下文窗口比对过。窗口越小越危险：
 * 40k 的有效窗口上，压缩完的"保留区"就能占掉 40%，压缩本身几乎白做。
 *
 * 这里把两者放进同一个天花板下按优先级切分：tail 先拿（最近的原文信息密度
 * 最高），剩下的给用户消息。天花板是窗口的 25%，夹取到 [4k, 16k] —— 上界
 * 等于原来的 8k + 8k，所以大窗口下行为不变，只有小窗口才会真正收紧。
 *
 * 不在此仲裁的第三个消费者：`POST_COMPACT_TOKEN_BUDGET`（压缩后重新读回的
 * 文件内容）。它计量的是重新读盘的文件而不是保留的对话原文，有自己的实测
 * 依据，合并进来会改动一个没人要求改的行为。
 */

/** 保留区总预算占有效上下文窗口的比例。 */
export const POST_COMPACT_PRESERVE_FRACTION = 0.25
/** 总预算下界：保证 tail 与用户消息各自至少拿到 2k。 */
export const POST_COMPACT_PRESERVE_MIN_TOKENS = 2 * PRESERVE_RECENT_MIN_TOKENS
/** 总预算上界：与仲裁前的 8k + 8k 相同，大窗口下行为不变。 */
export const POST_COMPACT_PRESERVE_MAX_TOKENS = 16_000

export type PostCompactBudget = {
  /** 天花板，等于下面两项之和。 */
  total: number
  /** 逐字保留的最近 API round。 */
  tail: number
  /** 保留的真实用户消息（HEAD+TAIL 段）。 */
  preservedUser: number
}

export function allocatePostCompactBudget(
  effectiveWindowTokens: number,
): PostCompactBudget {
  const total = Math.min(
    POST_COMPACT_PRESERVE_MAX_TOKENS,
    Math.max(
      POST_COMPACT_PRESERVE_MIN_TOKENS,
      Math.floor(effectiveWindowTokens * POST_COMPACT_PRESERVE_FRACTION),
    ),
  )
  // tail 优先，但不能吃掉整个天花板 —— 给用户消息留下界那一份。
  const tailCeiling = total - PRESERVE_RECENT_MIN_TOKENS
  const tail = Math.min(
    preserveRecentBudget(effectiveWindowTokens),
    tailCeiling,
  )
  return { total, tail, preservedUser: total - tail }
}
