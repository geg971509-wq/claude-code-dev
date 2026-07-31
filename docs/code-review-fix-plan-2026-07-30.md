# 缺陷修复计划（源自 code-review-2026-07-30.md）

8 项修复，全部为局部最小改动，不改变现有功能、不新增特性。

> **事实性审计批注（2026-07-31）**：本计划已逐条核对当前工作区源码。
> **第 6 行按字面实施会让本计划自己的验收标准（`bun run precheck` 零错误）失败**，
> 第 5、7、8 行的改动量/范围描述有误。原表保留在下方未删改，修正版见「审计修正后的执行表」。

## 审计结论摘要

| 行 | 定位 | 按字面实施的结果 |
|---|---|---|
| 1 | ✅ | 可行；但触发面被高估，属防御性加固（详见报告 #1 批注） |
| 2 | ✅ | 可行，完全准确 |
| 3 | ✅ | 可行，完全准确 |
| 4 | ✅ | 可行；但该函数全仓库零调用点，属库内语义纠错 |
| 5 | ✅ | 可行，但**不是一行**：`ide.ts` 未 import `pipeline`，需 +1 行 import |
| 6 | ✅ | ❌ **precheck 失败** —— 见下方说明 |
| 7 | ⚠️ | ❌ 四处中 responsesAdapter 已有 NaN 防护；`claude.ts` 语义/默认值不同，不可并入 |
| 8 | ✅ | ⚠️ 只补一处会漏掉同文件 `:540` 的同类缺陷 |

### 第 6 行为何会让 precheck 失败

计划写的是 `getMaxBashTimeoutMs()`，它在 `src/utils/timeouts.ts:28`。`BashTool.tsx` 里没有它，
新增 `import { getMaxBashTimeoutMs } from 'src/utils/timeouts.js'` 就是给 `builtin-tools`
**新增一条 `from 'src/...'` 反向导入**，触碰按包边界棘轮：

```
$ bun scripts/check-boundaries.ts
[boundaries] OK: 1209 reverse imports across 3 package(s) (== baseline)
scripts/boundaries-baseline.json:  "builtin-tools": 1206     ← 只减不增
```

1206 → 1207 直接失败，而 `bun run precheck` 包含 `check:boundaries`。

**正确写法**：用 `BashTool.tsx:66` 已经 import 的 `getMaxTimeoutMs()`
（`BashTool/prompt.ts:31` 的 wrapper，内部转调 `getMaxBashTimeoutMs`），零新增 import。

## 审计修正后的执行表

| # | 文件 | 改动 | 相对原表 |
|---|------|------|---------|
| 1 | `src/utils/skills/skillChangeDetector.ts:258-278` | 同原表；可选一并给 `src/cli/print.ts:1864` 的 `void getCommands(...).then(...)` 补 `.catch(logError)` | 定级降为加固 |
| 2 | `src/query.ts:1468,1475,1557` | 同原表 | 不变 |
| 3 | `src/utils/sessionStorage.ts:660-701` | 同原表 | 不变 |
| 4 | `packages/mcp-client/src/connection.ts:92-95` | 同原表 | 定级降为语义纠错 |
| 5 | `src/utils/ide.ts:1450-1455` | 替换为 `await pipeline(...)` **并新增** `import { pipeline } from 'stream/promises'` | 两行，非一行 |
| 6 | `packages/builtin-tools/src/tools/BashTool/BashTool.tsx:1016` | `Math.min(Math.max(timeout ?? getDefaultTimeoutMs(), 1), getMaxTimeoutMs())` —— **用 `getMaxTimeoutMs`，勿 import `getMaxBashTimeoutMs`** | 修正函数名 |
| 7 | `src/services/api/client.ts:144`、`openai/client.ts:62`、`grok/client.ts:34` | 提取 `getApiTimeoutMs()`（NaN/非正数落回 600s），**三处**替换。`responsesAdapter.ts:1336-1341` 已有 `Number.isFinite` 兜底，仅可选清理魔法值；**`claude.ts:839-843` 不动**（默认 300s/120s，语义不同） | 4 处 → 3 处，claude.ts 移出 |
| 8 | `src/utils/sideQuery.ts:770-773` **和 `:536-543`** | 两处 catch 各加 `logForDebugging`（`:32` 已 import） | 1 处 → 2 处 |
| 6b | `packages/builtin-tools/src/tools/PowerShellTool/PowerShellTool.tsx:807` | 可选：已有 `Math.min(...)` 上界钳制，缺下界，与 #6 同步补 `Math.max(..., 1)` | 新增（原表遗漏的同类点） |

规模修正：**10 个已有文件 + 1 个新模块**（原表口径下为 8 个），约 12-13 处函数级改动。

---

## 原始计划（2026-07-30，未删改）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/utils/skills/skillChangeDetector.ts:258-278` | 防抖 `setTimeout(async ...)` 回调体包 try/catch，catch 中 `logError(toError(err))` |
| 2 | `src/query.ts:1468,1475,1557` | 三处 `void executeStopFailureHooks(...)` 追加 `.catch(logError)` |
| 3 | `src/utils/sessionStorage.ts:660-701` | `drainWriteQueue` per-file 循环体包 try/catch：失败时 `logError` + 仍调用该 batch 全部 resolvers 释放等待方；单文件失败不中断其他文件 |
| 4 | `packages/mcp-client/src/connection.ts:92-95` | 超时回调改 `try { await onTimeout() } finally { reject(...) }` |
| 5 | `src/utils/ide.ts:1450-1455` | 手写 pipe promise 替换为 `await pipeline(vsixResponse.data, writeStream)`（`stream/promises`） |
| 6 | `packages/builtin-tools/src/tools/BashTool/BashTool.tsx:1016` | `timeoutMs` 钳制到 `[1, getMaxBashTimeoutMs()]` |
| 7 | `src/services/api/client.ts:144`、`openai/client.ts:62`、`grok/client.ts:34`、`openai/responsesAdapter.ts:1336-1339` | 提取带 NaN/非正数防护的 `getApiTimeoutMs()`（放 `src/services/api/` 下新小模块或就近常量文件），四处统一调用 |
| 8 | `src/utils/sideQuery.ts:770-773` | 工具参数 `JSON.parse` 失败的空 catch 中加 `logForDebugging`，不改变"以 `{}` 继续"的现有行为 |

## 验收

- `bun run precheck` 零错误（typecheck + lint fix + test）。
- 每处改动不引入新导出以外的 API 变化（仅 #7 新增一个内部函数）。
- 成功路径行为逐行等价；仅失败路径从"崩溃/挂起/静默"变为"记录日志 + 既定降级"。

## 三方审计共识（2026-07-30，3 个独立 agent，均 ≤4 分钟）

8 项全部达成共识（反对票 0），按审计修正执行：

| # | 共识结论 | 审计修正 |
|---|---------|---------|
| 1 | 同意 | try/catch 包整个回调体；用文件内已有 `logForDebugging`，不新增 import |
| 2 | 同意 | 无修正，`logError` 已在 query.ts:40 import |
| 3 | 同意 | 补全 mid-loop flush 失败时的 resolver 释放（Set 追踪，finally 兜底，保证每个 resolver 恰好调用一次） |
| 4 | 同意 | `onTimeout()` 自身抛错需同时 catch（否则仍 unhandled rejection），定级降为语义纠错（该函数当前零调用点） |
| 5 | 同意 | 需补 `stream/promises` import（共 2 行改动） |
| 6 | 同意 | 必须用已 import 的 `getMaxTimeoutMs()`（直接用 `getMaxBashTimeoutMs` 会触发 packages→src 边界棘轮失败）；沿用 `||` 而非 `??` 保持 timeout=0 既有语义；同步补 PowerShellTool 下界 |
| 7 | 同意 | 范围收窄为 3 处（responsesAdapter 已有 isFinite 兜底；claude.ts 语义不同不可并入）；函数放 `src/utils/timeouts.ts`，与既有 `getDefaultBashTimeoutMs` 同型 |
| 8 | 同意 | 同修两处（:536-543 流式累积路径 + :770-773 非流式路径），否则人为制造路径不一致 |

文档更新结论：无需更新 AGENTS.md（仅失败路径改动，成功路径等价，无接口/行为/配置/架构变化）。

## 执行结果

- 修改文件（11 个）：`src/utils/skills/skillChangeDetector.ts`、`src/query.ts`、`src/utils/sessionStorage.ts`、`packages/mcp-client/src/connection.ts`、`src/utils/ide.ts`、`packages/builtin-tools/src/tools/BashTool/BashTool.tsx`、`packages/builtin-tools/src/tools/PowerShellTool/PowerShellTool.tsx`、`src/utils/timeouts.ts`、`src/utils/sideQuery.ts`、`src/services/api/client.ts`、`src/services/api/openai/client.ts`、`src/services/api/grok/client.ts`
- 验证：`bun run precheck` 全量通过 —— `tsc --noEmit` 零错误；`biome check --fix` 无修复项（Checked 3400 files）；`check:boundaries` OK（1209 == baseline，未新增反向依赖）；`bun test` 6385 pass / 0 fail（486 个测试文件）。

> **【审计 2026-07-31】验收条款修正**
>
> - `bun run precheck` 实际包含 **typecheck + lint fix + boundaries + test**，
>   原文漏了 `check:boundaries` —— 而这正是第 6 行按字面实施会失败的那一环。
> - "仅 #7 新增一个内部函数"不准确：#7 新增的是**新模块中的导出函数**（供 3 个 client 跨文件调用），
>   不是模块内私有函数。
> - "成功路径行为逐行等价"在修正后的方案下成立；但**原表第 7 行不成立** ——
>   把 `claude.ts:839-843`（默认 300s / 远程 120s）并入统一的 600s 默认会改变成功路径行为。
>   修正表已将 claude.ts 移出范围。
