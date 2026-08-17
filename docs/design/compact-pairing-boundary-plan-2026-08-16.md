# Compact pairing boundary（dsh 借鉴，本轮唯一交付）

Status: proposed
Date: 2026-08-16

## 0. 目标 / 约束 / 已知事实

**目标**：压缩切分不得拆开未闭合的 `tool_use` / `tool_result` 对。只修切分点，不修 API 发送时的合成补洞。

**本轮不做**：Code Mode、Goal/Ralph 外层策略、Cordis、ACP sidecar、改 `grouping.ts` 的 API-round 边界算法。搬纯函数进该文件 ≠ 改边界语义。PTL 丢 head 前缀（`truncateHeadForPTLRetry`）也不做。

| 判断 | 标注 |
|---|---|
| `adjustIndexToPreserveAPIInvariants` 只被 `sessionMemoryCompact.calculateMessagesToKeepIndex` 调用（该函数内 3 处） | 【事实】 |
| `selectPreservedTail` 按整轮 API round 切 `head`/`tail`，不调用上述函数 | 【事实】 |
| `ensureToolResultPairing`（`src/utils/messages.ts:5616`）是发送前修补（合成/剥离），不是切分不变量 | 【事实】 |
| 良构对话里 pairing 已由 assistant-id 边界自然成立（`grouping.ts:6-11,34-42`） | 【事实】 |
| 非空 tail 的 `tail[0]` **一定是 assistant**：`groupMessagesByApiRound` 从第二组起总是以新 assistant 开组；`firstKeptRoundIndex===0` 会走「整段进 tail」空 tail。`selectPreservedTail` **不会**产出「以孤儿 `tool_result` 开头」的 tail | 【事实】 |
| 畸形洞：新 assistant id 插在 `tool_use` 与 `tool_result` 之间 → result 落入后一轮、use 留在前一轮。非空 tail 的第一轮**内部**带孤儿 result，`tail[0]` 仍是那个新 assistant | 【事实】依据：`grouping.ts:44-51` |
| SM 的 keep-index 按**条**回走，`startIndex` 可以落在 `tool_result` 上；tail 按**轮**切，同一函数要防的是跨轮孤儿，不是「首条就是 result」 | 【事实】 |
| 其它切分数组：`truncateHeadForPTLRetry`（`compact.ts:334`）按 round **丢 head 前缀**；`microCompact`/`snipCompact`/`preservedUserMessages` 不是 keep-suffix index 切。本轮只补 tail；PTL 仍靠发送时 `ensureToolResultPairing` | 【事实】+ 范围 |
| 把 SM 的 index 回退接到 tail 起点（`start = length - keptMessageCount`）语义正确：只把 start **左移**并入缺失的 `tool_use` / 同 `message.id` thinking；head 仍是 `messages.slice(0, adjusted)` 真前缀 | 【事实】 |
| 良构路径上 `adjustIndex` 对 round 切分是 no-op（use/result 同组） | 【事实】 |
| 仓库无 `sessionMemoryCompact` / `adjustIndex` 单测；`grouping.test.ts` 只测 `groupMessagesByApiRound` | 【事实】 |

约束：最短 diff；不新增 feature flag；不改 `query()` 抛错契约；测试不 mock 上层业务模块。

## 1. 方案

抽出 SM 已有的配对回退，接到 `selectPreservedTail` 的切分点。

**取消 `pairing.ts`。** 两个调用方不够撑一个新模块。`tailPreservation` 不能 import `sessionMemoryCompact`（`SM → compact.ts → tail`，反向成环）。已有叶子 `grouping.ts`（本就是为断环抽出）承接这 3 个纯函数。`groupMessagesByApiRound` 的「不跟踪 pairing」是边界算法注释，不是「此文件禁止再放纯函数」。

工程约束（落点可以、语义不能混）：
- `groupMessagesByApiRound` **不得**调用 `adjustIndex`。文件头加一句：round 边界仍只看 assistant-id；`adjustIndex` 只给 SM keep-index / tail 切分点回退。
- 新边 `SM → grouping` 可接受（grouping 是叶，不成环）。
- 禁止 `tail → SM`。

1. 把 `getToolResultIds`、`hasToolUseWithIds`、`adjustIndexToPreserveAPIInvariants` 挪到 `grouping.ts`。两助手保持 unexported。`sessionMemoryCompact.ts` 改 import，**不** re-export。
2. `selectPreservedTail`：只在现有三条空 tail 早退之后（`maxRounds<=0` / 最新轮超预算 / 整段都进 tail）对 `start = messages.length - keptMessageCount` 调 `adjustIndexToPreserveAPIInvariants(messages, start)`。
   - 不改 greedy 预算循环（仍整轮取舍）
   - 回退按**消息下标**左移，**不要**再吸附到 round 起点。`adjustIndex` 本就会切进上一轮内部（thinking 同 `message.id`、跨轮孤儿 result），与 SM 同一函数。写「不拆 round」会多写一层错逻辑
   - **回退后必须重跑「整段都进 tail」fallback**：`adjusted <= 0` 则 `{ head: messages, tail: [] }`，否则 `slice(0, adjusted)` / `slice(adjusted)`。缺这步会得到空 head + 全量 tail → `compact.ts:582` `recentTailPreserved=true` 且 `forkContextMessages=[]`，摘要 fork 与 prompt 注记同时说谎。现有「everything fits」单测也会挂
   - `compact.ts` **不改**。`recentTailPreserved` / `tailPreservedTokens` / `getCompactPrompt` / `forkContextMessages=head` / `truePostCompactTokenCount` 都读最终切片；超预算靠实际 `messagesToKeep` 重估，不要抬 `PRESERVE_RECENT_MAX_TOKENS`（会踩 `buildPostCompactMessages.test.ts` 的 50k 常量绊线）
3. 测试：`tailPreservation.test.ts` **只加 1 条**。fixture 必须是 array content（现有 `makeRound` 是 string，`getToolResultIds` 直接 `[]`）。形状必须是跨轮畸形，**不要**写成 tail 以 `tool_result` 开头（grouping 做不到）：
   `[无关前缀…][thinking id=X][tool_use T1 id=X][assistant id=Y][tool_result T1]`，`maxRounds=1`。
   前缀至少 1 条不相关消息，否则 `adjusted<=0` 走空 tail，锁不住「并入」。
   断言：`tool_use`+thinking 进 tail；`head === messages.slice(0, head.length)` 且 `tail === messages.slice(head.length)`（现有 prefix 不变量，`tailPreservation.test.ts:95-96`）。
   现有空 tail / `maxRounds=0` / 整段进 tail 三条不得改。不新造 SM 套件。
4. 文档：不扩写 `compaction.mdx`。`## 工具对完整性保护` 里 `// grouping.ts — adjustIndex…`（约 L123）**已经**写成 grouping，落地后对一下即可。`// sessionMemoryCompact.ts:324-397`（L93）是 `calculateMessagesToKeepIndex`，**不要**改成 grouping。**本计划文件落地后删除。**

不引入 `toolPairingBalancedBefore/After`——本仓已有单向回退，够用。

## 2. 函数清单（预计 3）

| 动作 | 函数 / 文件 |
|---|---|
| 搬到 `grouping.ts` | `getToolResultIds`、`hasToolUseWithIds`（unexported）、`adjustIndexToPreserveAPIInvariants` |
| 改 | `sessionMemoryCompact.ts` import；`selectPreservedTail` |
| 测 | `tailPreservation.test.ts` 一条（跨轮孤儿 result + 同 id thinking） |
| 文档 | `compaction.mdx` 只核 L123，不改 L93、不新开节 |

≤8，本可直接改；按 Desktop `AGENTS.md` 仍走计划 → 4 审 → 共识 → 执行。

## 3. 验证

搬迁锁的是 import 编译，不是 SM 套件。

```
bun test src/services/compact/__tests__/tailPreservation.test.ts
bun test src/services/compact/__tests__/grouping.test.ts
```

落地后 grep：`adjustIndexToPreserveAPIInvariants` 只从 `grouping.ts` 导出，调用方仅 `sessionMemoryCompact.ts` 与 `tailPreservation.ts`。`groupMessagesByApiRound` 不得调用它。不跑全量 `precheck`，除非上述失败。

## 4. 不确定

- 畸形 tail 在生产是否真出现：有测试锁，无线上证据。【未知】
- 回退后 tail 超预算：接受（正确性 > 预算）；不为此再丢一轮。记账闭环靠 `selectPreservedTail` 返回最终切片，不改 `compact.ts`。【设计选择】
