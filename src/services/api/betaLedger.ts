/**
 * 被服务端拒绝过的 beta header 账本。
 *
 * 官方的做法是每会话维护一个 `{ sent, rejected }`：400 里点名哪个 beta 不
 * 认识，就把它从本会话摘掉并重发一次（`t5(state, beta)` + `retry:*-beta`）。
 * dev 此前只有静态门 —— `shouldIncludeFirstPartyOnlyBetas()`、
 * `BEDROCK_EXTRA_PARAMS_HEADERS`、`VERTEX_COUNT_TOKENS_ALLOWED_BETAS`，外加
 * 若干"某网关会 400"的专门分支。那是开环的：每遇到一种新端点怪癖就得再加
 * 一条门，而在加上之前，用户看到的是整轮请求失败。
 *
 * 这里只记 rejected，不记 sent。摘掉一个本来就没发的 header 是空操作，为它
 * 维护第二个集合只会在并行子代理之间引入共享状态竞争。
 *
 * 作用域是进程 —— CLI 一个进程一个会话，与官方的"本会话"等价；子代理共享
 * 同一进程，这正是想要的：一个 header 在子代理那里被拒，主循环也别再发。
 */

/** beta header 的形状：`name-YYYY-MM-DD`。 */
const BETA_HEADER_SHAPE = /[a-z][a-z0-9]*(?:-[a-z0-9]+)*-20\d\d-\d\d-\d\d/g

const rejected = new Set<string>()

export function isBetaRejected(header: string): boolean {
  return rejected.has(header)
}

export function markBetaRejected(header: string): void {
  rejected.add(header)
}

/** 测试用 —— 账本是模块级的，用例之间必须清干净。 */
export function resetRejectedBetas(): void {
  rejected.clear()
}

export function getRejectedBetas(): readonly string[] {
  return [...rejected]
}

/**
 * 400 报文点名的 beta header。
 *
 * 两道闸：必须是 400，且报文里要出现 `anthropic-beta` —— 否则一个碰巧含有
 * `xxx-2026-01-01` 字样的普通 400 会被误判成 beta 拒绝，把无关的 header 摘
 * 掉。已经被摘过的不再返回，避免同一个 header 反复触发重试。
 */
export function findRejectedBetas(
  status: number | undefined,
  message: string | undefined,
  exclude: readonly string[] = [],
): string[] {
  if (status !== 400 || !message?.includes('anthropic-beta')) {
    return []
  }
  BETA_HEADER_SHAPE.lastIndex = 0
  return [...new Set(message.match(BETA_HEADER_SHAPE) ?? [])].filter(
    header => !rejected.has(header) && !exclude.includes(header),
  )
}
