# Agent 增强第二批移植计划（kimi/pi 参考，经前提核实修正）

日期：2026-07-30。第一批（tool-dedup/summary-gate/compact-preserve）已完成。
本批三项均经"当前仓库现状核查"修正，只补真实缺口，避免重复建设。

## 项 1（修正版）：max_output_tokens 路径补 streamingToolExecutor.discard()

**前提核实结论**（替代原 pi 移植项）：截断消息的 JSON 不完整 tool_use 在本仓库不会被执行（1P content_block_stop 门控 + 3P malformed 标记 + toolExecution 双重拒执），pi 的"整批拒执"无增量价值，**取消**。

**真实缺口**：`src/query.ts` 的 max_output_tokens 三条路径丢弃了仍在执行的流式工具：
- 升级路径（:1513-1534，8k→64k escalate，continue 前）
- 多轮恢复路径（:1537-1565，continue 前）
- 恢复耗尽路径（:1568-1584，return 前）

后果：工具副作用 detached 发生但结果被弃，`ensureToolResultPairing` 事后补合成 error tool_result——模型看到与事实相反的"工具被中断"（文件实际已写）。

**修复**：三条路径各加 `streamingToolExecutor?.discard()`，完全照抄既有 fallback 路径（:1193-1199）的模式。`discard()` 已实现 abort 子进程 + 合成 error 结果（StreamingToolExecutor.ts:81-102），本就是为该场景设计，这三处是漏接。
**改动量**：3 行 + 注释。无 flag（缺陷修复，与 fallback 路径行为对齐）。
**测试**：typecheck + 现有测试不回归；无新增单测（generator 级集成路径，e2e 成本过高，同第一批机制 1 的取舍）。

## 项 2：同文件 mutation 串行化（pi file-mutation-queue 移植）

**问题**：跨 query loop（主 loop 与并行子 agent）对同一文件的 Edit/Write 并发，fileHistory v1 备份被覆写（首批审计已确认的竞态），edit 内容也可能交错。同批内 mutation 已被 isConcurrencySafe 串行，缺口只在跨 loop。

**设计**：
1. 新模块 `src/services/tools/fileMutationQueue.ts`（纯逻辑）：
   - `withFileMutationLock<T>(path: string, fn: () => Promise<T>): Promise<T>`——模块级 `Map<key, Promise>` 链式互斥；key = 路径 normalize（resolve + 统一分隔符）；fn 结束（含抛错/abort）后释放并清理 Map 项，防泄漏。
2. 接入 `toolExecution.ts` 的 `runToolUse`（:376，进程级唯一汇点）：权限检查之后、`tool.call` 调用处。判定：`const path = tool.getPath?.(input)` 且 `!tool.isReadOnly(input)` → 走锁；否则原样。（Tool.ts:539 已有 `getPath?` 可选方法；FileEdit/FileWrite 有实现，NotebookEdit 用 `notebook_path` fallback——实现时确认 isReadOnly 签名，若以 isConcurrencySafe 为准则按其语义。）
3. 固有边界写注释：Bash/PowerShell 重定向写文件覆盖不到（命令文本解析不出路径）。
4. Flag：`FILE_MUTATION_QUEUE`，注册 + 默认启用。

**测试**：`src/services/tools/__tests__/fileMutationQueue.test.ts`——同 path 串行/异 path 并行/异常释放/Map 不泄漏。

## 项 3：并行子 agent 启动限速（kimi AIMD 移植，启动限速版）

**问题**：N 个并行子 agent 在 rate limit 期间各自独立重试 = N× 请求放大，加剧限流。withRetry 的 per-request 退避不限制"新 agent 启动"。

**设计（全量 AIMD 降级版，与 withRetry 职责不重叠）**：
1. 新模块 `src/services/api/agentLaunchController.ts`（纯逻辑 + 可注入时钟便于测试）：
   - 状态：`throttledUntil`（epoch ms）、`cooldownMs`（当前退避，初始 1000，上限 30000）、`lastRateLimitAt`。
   - `noteRateLimited()`：距上次限流 <3 分钟则 cooldown 翻倍（封顶），否则重置为初始；`throttledUntil = now + cooldown`。
   - `acquireLaunchSlot()`：若 `now < throttledUntil` 则 sleep 差额；随后串行化启动（同一时刻只放行一个，间隔最小 250ms 防启动尖峰）。
   - 纯时间函数注入 `now: () => number` 与 `sleep`，单测零 mock。
2. 信号钩子：`withRetry.ts` 429/529 识别处（isTransientCapacityError / fast-mode :270 附近）调 `noteRateLimited()`。
3. 门控钩子：`runAgent.ts` try 块入口（:788 附近）`await acquireLaunchSlot()`——一处覆盖前台/后台/swarm teammate 三路（全部汇入 runAgent）。
4. Flag：`AGENT_LAUNCH_THROTTLE`，注册 + 默认启用。flag off 时两钩子为零成本 no-op。

**测试**：`src/services/api/__tests__/agentLaunchController.test.ts`——首次不限速/限流后等待/翻倍与封顶/超时衰减/启动串行化。

## 通用约束

- 项 2/3 的 flag 注册进 `src/constants/featureFlags.ts` + `scripts/defines.ts` DEFAULT_BUILD_FEATURES；`feature()` 只用于 if/三元条件位。
- 新模块全部纯逻辑 + 薄接入；每处接入 ≤20 行。
- 成功路径行为不变：项 1 只补 discard；项 2 只加串行序；项 3 只在限流后延迟启动。
- 完成后 `bun run precheck` 零错误；CLAUDE.md 默认 features 段补 2 个 flag。
- 修改函数 >6 个，按流程 3 agent 审计共识后执行。

## 三方审计共识修正（2026-07-30，3 agent 全部返回，0 反对）

### 项 1（同意按原样，2 点精确化）
1. discard() 本身不合成 error 结果（只 abort + 清理 bookkeeping），配对由 ensureToolResultPairing 兜底——无双重合成风险。
2. 耗尽路径的插入点必须在 `:1569 yield lastMessage` 之前（max_output_tokens 块内），**不可**放 `:1580` 通用 isApiErrorMessage return 处（会越界改所有 API 错误路径）。

### 项 2（4 条修正）
1. 包 `invokeToolCall` lambda（toolExecution.ts:1319）而非在 1894 行函数里内联新分支——与 skill-learning wrapper 正交组合。
2. 锁 key 用 backfill 后 input 的 getPath（backfillObservableInput 已展开 `~`），key = resolve(path)，不引入额外归一化。
3. 排队期 abort：放弃执行也必须 resolve 自己的链节，否则锁链楔死（补单测）。
4. 注释声明：CronCreate/CronDelete 经 getPath 命中锁属有意接受；MCP 工具无 getPath 不受影响；Bash/PowerShell 重定向覆盖不到。

### 项 3（4 条修正）
1. **边界棘轮**：runAgent.ts（builtin-tools）不得 import src 模块。改为 setter 注入：builtin-tools 本地 `launchThrottle.ts` 持可变实现（默认 no-op）+ `setAgentLaunchThrottle()`；src 侧（src/tools.ts 装配处）注册 `src/services/api/agentLaunchController.ts` 的实现。withRetry.ts 直接 import src controller（src→src 合法）。
2. **砍 AIMD**：删除翻倍/衰减/250ms 启动间距，只留单一冷却门：`throttledUntil = now + (retryAfterMs ?? 10s, 封顶 30s)`。真正价值只在"限流冷却期内暂缓新启动"。
3. **abort-aware sleep**：用 `sleep(ms, signal, {abortError})` 现成模式（withRetry.ts:291 先例）；等待 >2s 时 logForDebugging。
4. **钩子位置**：withRetry catch 块顶部显式判 `error.status === 429 || is529Error(error)`（isTransientCapacityError 与 fast-mode 分支都不是统一汇点）。已知边界：OpenAI/Grok 兼容层绕开 withRetry，信号不覆盖（注释声明）。

### 通用
flag 命名通过（FILE_MUTATION_QUEUE、AGENT_LAUNCH_THROTTLE）；项 1 无 flag；CLAUDE.md 只补 2 个 flag 名。

## 执行结果（2026-07-30）

- **项 1**：`src/query.ts` 三处补 `streamingToolExecutor?.discard()`（escalate/recovery/耗尽，均插在 continue/return 前，未碰通用 API 错误 return）。
- **项 2**：新模块 `src/services/tools/fileMutationQueue.ts`（链式 promise 互斥 + 排队期 abort 释放 + Map 自清理）；接入 `toolExecution.ts` 包 `invokeToolCall` lambda（与 skill-learning wrapper 正交）；锁 key 用 backfill 后 input + resolve。单测 8 例通过（含"排队中 abort 不楔死锁链"）。
- **项 3**：新模块 `src/services/api/agentLaunchController.ts`（单一冷却门：retry-after ?? 10s，封顶 30s，abort-aware sleep）；`packages/builtin-tools/.../launchThrottle.ts` setter 注入（默认 no-op）；`withRetry.ts` catch 顶部 429/529 统一钩子；`src/tools.ts` 启动注册；`runAgent.ts` try 入口门控。单测 8 例通过。
- **flags**：`FILE_MUTATION_QUEUE`、`AGENT_LAUNCH_THROTTLE` 注册 + 默认启用；CLAUDE.md 已同步。
- **排障**：边界棘轮曾误报 +1——原因是 launchThrottle.ts 注释里逐字写了示例 import specifier 被检查器 regex 计入，改写注释后恢复 1209 == baseline。
- **排障 2（环境性测试失败）**：`toolExecution.stale` 测试失败与本次改动无关（clean HEAD 同样失败）。根因：`hasHookForEvent`（src/utils/hooks.ts:1727）对缺 `sessionHooks` 字段的 AppState 直接 TypeError——测试 ctx 不含该字段；此前通过是因为当时用户 settings 配了 PreToolUse hook，提前 return 绕过了崩溃行，settings 变动后暴露。已修复为 `appState?.sessionHooks?.get(...)`（1 个 `?.`），runner 恢复通过。这属于真实健壮性缺陷（部分 AppState 消费方如测试/headless 路径不带 sessionHooks），顺带修复。
- 验证：`bun run precheck` 全量通过 —— tsc 零错误；biome 无修复项（Checked 3418 files）；boundaries OK（1209 == baseline）；bun test 6485 pass / 0 fail（495 个测试文件）。
