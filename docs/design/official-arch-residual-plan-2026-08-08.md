# 官方对照 residual 计划（2026-08-08）

## 0. 授权与约束

- **来源**：对照 `/Volumes/work/software/install/claude-official`（webcrack `cli.js`）的 ≤8 项 residual 菜单；用户要求 **3 agent 审计做/不做** → 按 Desktop `AGENTS.md` 管计划/共识/执行。
- **硬约束**：
  - 稳定/正确优先；**不**重开已对齐轴：Phase A kind + `createPostAutoCompactTracking`、`ensureToolResultPairing`、stream idle 默认开、`yieldMissingToolResultBlocks`、工具并发 knob。
  - **不**并包、**不** DI、**不**把 `autoCompactIfNeeded` 改成 generator、**不**搬 GrowthBook 多源 window 全表。
  - 脏树并存（image 1+2、goal 等）：**只 stage/改本计划路径**。
  - 不 commit/push，除非另授。
- **分支**：`fix/stream-lifecycle-hardening`。

## 1. 菜单与终锁（3 critic 共识）

| # | 议题 | 终锁 | 原因 |
|---|------|------|------|
| 1 | Cold compact + strip | **DO 本批** | env 默认 off；只复用 `stripImagesFromMessages` |
| 2 | Reactive 阈值路由骨架 | **DEFER** | 无 multi-window 时恒 auto=死路径；与 query 413 reactive 双入口；等 #8 |
| 3 | `hook_blocked` kind | **DO 本批** | 熔断正确性；须先造 `blockedBy` 信号（本地 PreCompact 曾吞掉 blocked） |
| 4 | Byte-level stream idle | **DEFER** | 90s event 已严于官方 300s floor |
| 5 | `streamSuspended` 分类 | **DO 本批** | 纯映射；**不**改 retry/fallback 策略 |
| 6 | Mid-stream abort partial | **DEFER** | SDK 另开；不碰 REPL |
| 7 | autocompact generator | **NO** | 消费面大、收益小 |
| 8 | multi-source window | **DEFER 另 PR** | #2 前置 |

**Phase1 交付包（共识）**：`#3 → #1 → #5`。不编码 2/4/6/7/8。

三审均为 **APPROVE WITH PATCHES**（A 稳定 / B 耦合 / C 长时熔断）。

## 2. 实现步骤（共识补丁已并入）

### P0 — #3 `hook_blocked`（信号闭环）

【事实】`HookOutsideReplResult` 已有 `blocked`；`executePreCompactHooks` 未透出；官方返回 `blockedBy` 后 `throw` 前缀 `Compaction blocked by PreCompact hook`。

1. `executePreCompactHooks`：对齐官方——`blocked` 结果拼 `blockedBy`；返回 `{ …, blockedBy? }`。
2. `compact.ts`：`assertPreCompactNotBlocked(hookResult)` —— `blockedBy` 时 log + `throw Error(COMPACT_BLOCKED_BY_HOOK_PREFIX + ': ' + blockedBy)`；两处 PreCompact 调用后立刻 assert。
3. `autoCompact.ts`：`AutoCompactResult` 增 `hook_blocked`；catch 仅 `message.startsWith(COMPACT_BLOCKED_BY_HOOK_PREFIX)` → `{kind:'hook_blocked'}`，**不** `consecutiveFailures++`。
4. `query.ts`：`hook_blocked` 与 `not_needed` 同档 fall-through（可 logEvent）；不写 tracking.failures。
5. 单测：blockedBy throw → kind；failures 不变；非前缀仍 ++。

### P1 — #1 Cold + strip（禁止第二套 strip）

1. `isColdCompactEnabled()` ← `isEnvTruthy(CLAUDE_CODE_COLD_COMPACT)`。
2. `compactConversation` 可选末参 `options?: { stripNonEssential?: boolean }`（不重写位置参数全表）。
3. cold on：`autoCompactIfNeeded` 传 `stripNonEssential:true`；`compactConversation` 在 summarize 前对输入 messages 再调**已有** `stripImagesFromMessages`（path 已有一处；cold 保证入口即 strip，幂等可接受）。
4. log `tengu_cold_compact` 或 debug 一行。env off 零变化。
5. 单测：isColdCompactEnabled；strip 对 image→`[image]`。

### P2 — #5 classifyStreamSuspend（不拆子系统除非必要）

1. 纯函数 `classifyStreamSuspend({ streamIdleAborted, isStaleConnection?, isContextHintSse? })` 放 `src/services/api/streamSuspend.ts`（≤40 行）或同文件旁；映射 `watchdog|stale_connection|context_hint_sse|other`。
2. 写入 `logStreamIdleDiagnostics` + 现有 `fallback_cause` 可保留 `watchdog|other`；**新增** diagnostics 字段 `suspend_kind` 即可。
3. **禁止**本批改 nonstreaming fallback 是否触发。
4. 单测：4 行映射表。

### 明确不做

- #2/#4/#6/#7/#8；伪造 markApiFailure；image/goal 脏路径。

## 3. 文件清单

| 文件 | 动作 |
|------|------|
| `src/utils/hooks.ts` | PreCompact 返回 `blockedBy` |
| `src/services/compact/compact.ts` | assert blocked；可选 stripNonEssential |
| `src/services/compact/autoCompact.ts` | hook_blocked kind；cold gate；catch 分轨 |
| `src/query.ts` | 消费 hook_blocked（fall-through） |
| `src/services/api/streamSuspend.ts` | classify 纯函数（新，短） |
| `src/services/api/claude.ts` | diagnostics 接 suspend_kind |
| `src/services/compact/__tests__/hookBlockedAndCold.test.ts` | #3+#1 |
| `src/services/api/__tests__/streamSuspend.test.ts` | #5 |
| 本文件 | 共识 + 落地 |

## 4. 验证

1. `bun test src/services/compact/__tests__/hookBlockedAndCold.test.ts src/services/api/__tests__/streamSuspend.test.ts`
2. 相关 tsc 无 error
3. env off：cold 路径无 strip 额外调用语义（行为等价）

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| PreCompact 现网 hook 误设 decision=block | 对齐官方语义；block 才拒 |
| strip 幂等双调 | 已有 strip 只换 media 标记 |
| 脏树冲突 | 只改清单路径 |

## 6. Critic 摘要

| Agent | 整体 | 关键补丁 |
|-------|------|----------|
| A 稳定 | AWP | pin hook 信号；禁第二套 strip；#5 只写字段；#2 出 Phase1 |
| B 耦合 | AWP | #2 解绑；strip 在 compact 内；#5 不拆大系统 |
| C 熔断 | AWP | 本地 PreCompact 非阻塞是空转→造前缀 throw；query 矩阵；#5 不改 retry |

## 7. 共识修订

- Phase1 = **#3 + #1 + #5 only**（顺序 3→1→5）
- #2 从「同批骨架」**踢出**
- #3 必须先 `blockedBy` 再 kind；禁止 catch-all 当分轨

## 8. 落地记录（执行后填）

**状态：Phase1 完成（#3 → #1 → #5）** — 2026-08-08

| # | 改动 | 文件 |
|---|------|------|
| 3 | PreCompact `blockedBy` → assert throw 前缀 → `kind:hook_blocked`（不 ++failures）→ query fall-through + `tengu_auto_compact_hook_blocked` | `hooks.ts`, `compact.ts`, `autoCompact.ts`, `query.ts` |
| 1 | `CLAUDE_CODE_COLD_COMPACT` + `stripNonEssential` 复用 `stripImagesFromMessages` + `tengu_cold_compact` | `autoCompact.ts`, `compact.ts` |
| 5 | `classifyStreamSuspend` + `logStreamIdleDiagnostics.suspend_kind`；`fallback_cause` 仍 `watchdog\|other` | `streamSuspend.ts`, `claude.ts` |

**验证**：`bun test …/hookBlockedAndCold.test.ts …/streamSuspend.test.ts` → **11 pass / 0 fail**

**未做（共识）**：#2/#4/#6/#7/#8；未 commit/push。

## 9. Round2 锁法与落地（2026-08-08）

**锁法（用户：按最终建议）**：`1做 7做`；`2延后 3延后 4不做 5不做 6延后 8不做`（Round2 菜单编号，≠ Phase1）。

| # | 项 | 状态 |
|---|----|------|
| 1 | `suspend_kind` 输入接线 | **Landed** — `classifyStreamSuspendFromError` + `logStreamIdleDiagnostics` 用 err+idle；`fallback_cause` 仍 binary |
| 7 | reactive PreCompact block + cold 对称 | **Landed** — hook 前缀不 `logError`；cold 传 `stripNonEssential` |
| 2/3/4/5/6/8 | multi-window / reactive 路由 / byte / mid-abort / failure ledger / precompute | 未做 |

**文件**：`streamSuspend.ts`, `claude.ts`, `reactiveCompact.ts`, 两测文件。  
**验证**：`bun test …streamSuspend …hookBlockedAndCold` → **16 pass**；独立核验 agent **VERDICT PASS**（fallback binary、hook 不 logError、无 import cycle、deferred 未误做）。
