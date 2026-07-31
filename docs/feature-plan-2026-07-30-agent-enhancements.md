# Agent 能力增强移植计划（参考 kimi-code）

日期：2026-07-30。来源：kimi-code 三个机制的参考实现（`packages/agent-core/`），移植到本仓库。
原则：取机制精华、最简实现、纯增量、feature-flag 可控、不改动现有成功路径行为。

## 机制 1：工具调用死循环分级干预（TOOL_LOOP_DETECTION）

**问题**：agent 用相同参数反复调用同一工具（卡死循环）时无任何干预，烧 token 直到 max turns。

**kimi 参考**：`tool-dedup.ts`（per-turn 实例，跨 step 连击计数，3/5/8/12 四级，reminder 拼进工具结果尾部，12 级置 stopTurn）。

**移植设计（简化：只做跨步连击，不做同批去重的 Deferred 机制）**：

1. 新增纯逻辑模块 `src/services/toolLoopDetection.ts`：
   - `createToolLoopTracker()` → `{ record(toolName, input): { streak, level } }`
   - key = `toolName + ' ' + stableStringify(input)`；`stableStringify` 递归 key 排序（不可序列化退化 `String(input)`）。
   - 同一 key 连续出现 streak+1；不同 key 出现则重置。任何不同调用打断连击。
   - 级别：`streak>=3 → 'r1'`，`>=5 → 'r2'`，`>=8 → 'r3'`，`>=12 → 'stop'`。
   - `reminderForLevel(level, streak)` 返回注入文本（英文，文案沿用 kimi 原文：R1 声明期待新信息 / R2 三选一证伪-要输入-收尾 / R3 纯文本收尾）。
   - 全部纯函数/纯类，单测零 mock。
2. 接入 `src/query.ts` 工具结果收集循环（`for await (const update of toolUpdates)`，约 :1692）：该点同时覆盖 StreamingToolExecutor 与 runTools 两条路径。按 tool_use_id 从 `toolUseBlocks` 反查 name/input，逐条 `tracker.record()`；命中级别时把 `\n\n<system-reminder>…</system-reminder>` 追加到该工具结果消息的文本尾部（保留 isError）。
3. tracker 状态存入 query() 的 State（跟随 `maxOutputTokensRecoveryCount` 的 State 传递模式，:2061-2073），一个 query() 调用（= 一个用户 prompt 的处理全程）生命周期内有效。
4. `stop` 级：R3 文案追加后，工具结果照常 yield，随后按现有终态模式 `return { reason: ... }` 结束循环（参照 `model_error` 返回形状，reason 取现有联合中合适值或按类型定义最小扩展）。
5. 遥测：streak≥2 时 `logEvent('tengu_tool_loop_repeat', { tool_name, repeat_count, action })`。
6. Flag：`TOOL_LOOP_DETECTION` 注册进 `src/constants/featureFlags.ts` + `build.ts` 的 DEFAULT_BUILD_FEATURES。

**测试**：`src/services/__tests__/toolLoopDetection.test.ts`（纯函数：key 规范化、streak 重置、四级阈值边界、reminder 文案）。接入层用 faux script e2e（重复同名同参 tool_use 轮次，断言 reminder 出现）——若 e2e 成本过高则只保留纯函数单测 + query.ts 接入走 typecheck。

## 机制 2：子 agent 摘要质量门（SUBAGENT_SUMMARY_GATE）

**问题**：子 agent 最终文本过短（如 "Done."）时父 agent 拿不到完整 handoff。

**kimi 参考**：`subagent-host.ts:86-92,404-437`（最后一条非空 assistant 文本 <200 字符 → 追加一次固定扩写 prompt 的 turn，最多 1 次，仍短则接受）。

**移植设计**：

1. 接入点 `packages/builtin-tools/src/tools/AgentTool/runAgent.ts` 主 query 循环结束后（:834 附近，finally 之前），此处 `agentToolUseContext`/systemPrompt/context 均在作用域。
2. runAgent 当前逐条 yield 不累积消息——在循环内顺手 push 到本地数组（小改动）。
3. 判定：`lastAssistantText(messages)`（倒序找第一条文本非空的 assistant 消息，拼接 text blocks 后 trim）长度 < 200，且主循环正常结束（未 hit maxTurns、未 abort）、且非 fork 路径（`useExactTools`，保护 prompt cache byte-identical 前缀，见 runAgent.ts:688 注释）。
4. 命中则用同一 query() 再跑一轮：`messages: [...accumulated, createUserMessage({ content: EXPAND_PROMPT, isMeta: true })]`，`maxTurns: 1`，扩写轮消息照常 yield + 写 sidechain transcript。
5. EXPAND_PROMPT 沿用 kimi `summary-continuation.md` 文案（要求补充技术细节/发现/父 agent 须知信息）。
6. 常量 `SUMMARY_MIN_LENGTH = 200`、`SUMMARY_CONTINUATION_ATTEMPTS = 1` 集中在 runAgent.ts 顶部。
7. Flag：`SUBAGENT_SUMMARY_GATE`。

**测试**：`lastAssistantText` 抽成纯函数（agentToolUtils.ts 或新小模块）+ 单测（fixture 参照 `AgentTool/__tests__/agentToolUtils.test.ts` 的消息构造 helper）。扩写轮本身靠 typecheck + 现有 AgentTool 测试不回归。

## 机制 3：Compaction 保留真实用户消息 HEAD+TAIL（COMPACT_PRESERVE_USER_MESSAGES）

**问题**：本仓库 compact 是 summarize-all，原始任务陈述与近期用户指令全部消失，压缩后 agent 易跑偏。

**kimi 参考**：`compaction/handoff.ts`（保留真实用户消息原文，20k token 总预算 / 2k HEAD 预留，HEAD 取最老、TAIL 取最新，中间省略插 elision 标记）。

**移植设计（按 agent-14 调研结论：嵌入 summary 文本，避开 messagesToKeep 的 relink 复杂度）**：

1. 新增纯函数模块 `src/services/compact/preservedUserMessages.ts`：
   - `isRealUserMessage(msg)`：user 角色、非 `isMeta`、非 attachment、非 compact summary。
   - `selectPreservedUserMessages(messages, maxTokens=20000, headTokens=2000)` → `{ head: Message[], tail: Message[], omitted: boolean, omittedTokenEstimate: number }`。全部装得下则不省略；装不下时 TAIL 从最新往前贪心（18k），HEAD 从最老往后（2k），边界消息截断（HEAD 保开头、TAIL 保结尾），token 估算用 `src/services/tokenEstimation.ts` 的 rough 估算。
   - `formatPreservedSection(selection)` → 拼成文本块：HEAD 段标注 "oldest user input (original task)"，TAIL 段标注 "most recent user messages"，中间省略时插入 kimi 式 elision 说明（含省略 token 估算数）。
2. 接入 `compactConversation`（compact.ts:638-649 构造 summaryMessages 附近）：把 `formatPreservedSection` 产物作为标记段落追加进 compact 的 user summary message 文本（不动消息结构、不动 parentUuid 链、不动 `annotateBoundaryWithPreservedSegment`）。
3. Flag：`COMPACT_PRESERVE_USER_MESSAGES`。
4. 二次 compact 安全：被保留段落在 summary message 内部，下一轮 compact 时它随旧 summary 一起被新摘要覆盖，不堆叠（elision 标记同理）。

**测试**：`src/services/compact/__tests__/preservedUserMessages.test.ts`（fixture 参照 `grouping.test.ts` 的 `makeMsg` 模式）：全装下不省略 / 超预算时 HEAD+TAIL 双侧保留 / 边界截断方向 / isMeta 与 attachment 排除 / elision 文案。

## 通用约束

- 三个 flag 均注册进 `src/constants/featureFlags.ts`（类型注册表）+ `build.ts` DEFAULT_BUILD_FEATURES；`feature()` 只用在 `if`/三元条件位置。
- 新模块全部是纯逻辑 + 薄接入层；接入层改动每处 ≤30 行。
- 成功路径行为不变：机制 1 只在 streak≥3 才改工具结果；机制 2 只在 <200 字符时多跑一轮；机制 3 只增加 summary 文本内容。
- 完成后 `bun run precheck` 零错误；按需更新本计划文档的执行结果段。
- 修改函数数量 >6，按流程先经 3 个 agent 审计达成共识后执行。

## 三方审计共识修正（2026-07-30，3 agent 全部返回，0 反对）

### 机制 1 修正（6 条）
1. **只对非 isError 的工具结果计 streak**——权限拒绝/工具报错不计数（用户连续拒绝同一 Edit 12 次是合法行为，不能触发强制停止）。
2. **同批内同 key 只计 1 次**（batch 粒度），跨轮才累加——并发批（isConcurrencySafe）内 N 个相同调用不会直接跳到 r1。
3. **stop 级先 drain 当前批次**再终态返回——中途 return 会丢弃同批未消费的工具结果。
4. **终态 reason 加显式 case**：`getAutonomyTurnOutcome`（query.ts:205-229）default 分支把未知 reason 映射为 failed，新 reason 需加显式 case 映射为非 failed（死循环被拦截 ≠ turn 失败）。
5. **key 性能**：input 先截断（前 4KB）再 stableStringify，避免大文件内容全量递归序列化。
6. **砍掉 logEvent 遥测**（1P analytics 硬关闭，是死代码），改用 `logForDebugging`。已知限制写入注释：A→B 交替周期循环不检测（与 kimi 原版相同的盲区）。

### 机制 2 修正（5 条）
1. **零新增 src import（边界棘轮硬约束）**：`lastAssistantText`/EXPAND_PROMPT/常量全部落 `packages/builtin-tools/src/tools/AgentTool/` 本地新模块 `summaryGate.ts`，长 prompt 放本地并注释互指（参照 strip1mContextSuffix 双份模式）。
2. **扩写轮剥 tools**（`tools: []`）：消除"扩写轮发 tool_use 导致 max_turns 空转/意外副作用/递归 spawn"；扩写轮的 max_turns_reached attachment 吞掉。
3. **新增 maxTurns 标志位**：runAgent.ts:801 的 break 路径与正常结束无法区分，需显式 flag。
4. **只累积 isRecordableMessage 分支的消息**；扩写轮 `recordSidechainTranscript` 必须续 `lastRecordedUuid` 链，否则 transcript 链断裂。
5. **background agent 跳过 gate**；`feature()` 不进 `&&` 链，写两层嵌套 if。阈值保持 kimi 语义（无条件 <200 触发 1 次，记录为已知权衡：短答型子 agent 会白付一轮，attempts=1 成本有界）。

### 机制 3 修正（4 条）
1. **正确性硬修正**：`isRealUserMessage` 必须排除 content 含 `tool_result` block 的 user 消息（工具结果在消息模型里也是 user 角色，不排除会瞬间吃光 20k 预算）。
2. **注入顺序**：保留段拼进 summaryMessages 后再走 `truePostCompactTokenCount` 估算（compact.ts:662），确保 retrigger 判定基于真实 post-compact 体积；不会死循环的论证：二次 compact 时旧 summary（含保留段）被 `isCompactSummary` 排除逻辑（compact.ts:825）消化，新保留段只含上轮之后的用户消息。
3. **预算保持 20k/2k 常量**（约为 200k 窗口的 10%），不做动态化——retrigger 由现有估算机制正常捕获。
4. **显式声明范围**：sessionMemoryCompact（SM-compact 不走 compactConversation）不生效，属有意范围。

### 通用修正（3 条）
1. `DEFAULT_BUILD_FEATURES` 在 `scripts/defines.ts`（不是 build.ts）。
2. AGENTS.md 需更新：默认 features 段加 3 个 flag 名。
3. faux e2e 放弃（断言脆、性价比低），纯函数单测 + typecheck + 现有测试不回归为验收标准。

## 执行结果（2026-07-30）

三机制全部按共识修正版落地：

- **机制 1**：新增 `src/services/toolLoopDetection.ts`（纯逻辑：stableStringify/toolCallKey/tracker/四级文案/reminder 注入）；`src/query.ts` 接入（loop-local tracker，工具结果 yield 前注入，drain 后 force-stop 返回）；`src/query/transitions.ts` 新增 `tool_loop` 终态 + `getAutonomyTurnOutcome` 显式映射 cancelled。单测 `src/services/__tests__/toolLoopDetection.test.ts` 18 例通过。
- **机制 2**：新增 `packages/builtin-tools/src/tools/AgentTool/summaryGate.ts`（本地模块，零新增 src import，棘轮安全）；`runAgent.ts` 接入（hitMaxTurns 标志位、apiMessages 累积、fork/background/abort 豁免、扩写轮 tools:[] + maxTurns:1 + attachment 吞掉 + lastRecordedUuid 续链）。单测 `__tests__/summaryGate.test.ts` 7 例通过。
- **机制 3**：新增 `src/services/compact/preservedUserMessages.ts`（isRealUserMessage 排除 tool_result/meta/summary；HEAD 2k/TAIL 18k 贪心 + 边界双向截断 + elision 文案）；`src/services/compact/compact.ts` 在 summaryMessages 构造处、token 估算之前注入。单测 `__tests__/preservedUserMessages.test.ts` 21 例通过。
- **flags**：`TOOL_LOOP_DETECTION`、`SUBAGENT_SUMMARY_GATE`、`COMPACT_PRESERVE_USER_MESSAGES` 注册进 `src/constants/featureFlags.ts` + `scripts/defines.ts` 默认启用；CLAUDE.md（AGENTS.md）默认 features 段已同步。
