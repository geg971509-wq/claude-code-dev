# 工程实践与代码质量审查报告（2026-07-30）

范围：`src/` + `packages/` 全部 TypeScript 源码（排除 `dist/`、`node_modules/`）。
方法：8 路并行专项审计（异步流程 / 输入校验 / 架构依赖 / 资源泄漏 / 竞态并发 / 性能内存 / 重复代码 / 异常与可测性），所有发现均带文件:行号证据。
约束：严格不改变任何现有功能、不新增特性，只做缺陷修复与最小质量改进。

> **事实性审计批注（2026-07-31）**：本文已逐条核对当前工作区源码。所有文件:行号定位无误，
> 但 **5 条结论存在事实错误**，已就地以 `> 【审计 2026-07-31】` 引用块标注在对应条目下方。
> 原文一律保留，未删改，便于对照。摘要：
>
> | 条目 | 定位 | 机制 | 影响/触发面 | 结论 |
> |---|---|---|---|---|
> | #1 skillChangeDetector | ✅ | ✅ | ❌ hook 管线不可能 reject，P0 依据不成立 | 降级为防御性加固 |
> | #2 query.ts 三处 | ✅ | ✅ | ✅ | 完全准确 |
> | #3 sessionStorage | ✅ | ✅ | ✅ 三重损害全部证实 | 完全准确 |
> | #4 mcp-client 超时 | ✅ | ✅ | ❌ 函数全仓库零调用点 | 降级为库内语义纠错 |
> | #5 ide.ts pipe | ✅ | ✅ | ✅ | 完全准确 |
> | #6 BashTool timeout | ✅ | ✅ | ⚠️ 负数后果描述有误；漏了 PowerShell 先例 | 基本准确 |
> | #7 API_TIMEOUT_MS | ✅ | ❌ 只有三处裸奔 | ❌ 漂移叙事不成立 | 需重写 |
> | #8 sideQuery JSON.parse | ✅ | ⚠️ 缺陷为两处 | ❌ "两条路径不一致"说反了 | 需重写 |
>
> 工作区状态：审计时 8 项修复**一个都未落地**，`git status` 中 5 个相关文件的既有 diff 与本批次无关。

## 总体结论

代码库整体加固程度较高（资源清理、超时防护、边界棘轮均已有体系），真正遗留的问题集中在 **异步错误路径的闭环缺失**：若干 `setTimeout(async ...)` / `void promise` 浮动点会把可恢复错误升级为 `unhandledRejection → gracefulShutdown(1)` 进程退出或永久挂起。以下按优先级列出 8 个改进点。

---

## P0 — 崩溃 / 挂起风险（建议全部修复）

### 1. skillChangeDetector 防抖定时器回调无 try/catch —— 保存 skill 文件可致进程退出

- 位置：`src/utils/skills/skillChangeDetector.ts:258-278`
- 问题：`setTimeout(async () => { ... await executeConfigChangeHooks(...) })` 整个回调无 catch；hook 管线（spawn 子进程、读配置）一旦 reject 即成 unhandledRejection，全局处理器（`src/utils/gracefulShutdown.ts:319-341`）策略是 `gracefulShutdown(1)` 退出进程；且 `clearSkillCaches()` 被跳过。
- 触发面：用户日常保存 skill 文件 / git checkout 即可触发。
- 推荐修复：回调体包 `try { ... } catch (err) { logError(toError(err)) }`。
- 推荐原因：触发概率 × blast radius 乘积最大的单点，修复仅一层 try/catch，零行为变化。

> **【审计 2026-07-31】触发面描述错误，P0 依据不成立。**
>
> 定位与"回调无 try/catch"为真（`skillChangeDetector.ts:258-278`），`clearSkillCaches()` 确实会被跳过。
> 但 **hook 管线不可能 reject**，三层防护：
> 1. `getMatchingHooks` 整个函数体包在 `try { … } catch { return [] }` 里（`hooks.ts:1746` / `:2007`）；
> 2. `executeHooksOutsideREPL` 内 callback / http / command / prompt / agent / function 每个分支各自 try/catch，
>    失败一律返回 `{ succeeded: false, output: errorMessage }`（`hooks.ts:3271` / `:3501` 等）；
> 3. `return await Promise.all(hookPromises)`（`hooks.ts:3524`）收到的全是已 resolve 的 promise。
>
> 因此"用户日常保存 skill 文件 / git checkout 即可触发"不成立，"触发概率 × blast radius 乘积最大"也不成立。
>
> 回调里真正还能逃逸的是 `skillsChanged.emit()` —— `signal.ts:36` 是
> `for (const listener of listeners) listener(...args)`，同步遍历、无保护，listener 抛错会穿透到
> `setTimeout(async …)`。现有两个订阅者：`useSkillsChange.ts:28-41`（自带 try/catch，安全）、
> `print.ts:1863`（同步体安全，但内含另一个独立的浮动 promise
> `void getCommands(cwd()).then(...)` 无 `.catch` —— 本条 try/catch 挡不住它，属独立问题）。
>
> **结论**：修复（加一层 try/catch）仍然值得做，但定级应为 **防御性加固**，不是"日常触发的崩溃"。
> 若要真正闭环，需一并给 `print.ts:1864` 的 `.then()` 补 `.catch(logError)`。

### 2. query() 模型失败路径上三处浮动 promise 缺 `.catch`

- 位置：`src/query.ts:1468、1475、1557` — `void executeStopFailureHooks(...)` 无 `.catch`（对比同文件 :581 标准写法 `.catch(logError)`）。
- 问题：这三行只在模型已失败（prompt_too_long / model_error）的错误路径执行——hook 侧异常会把本已妥善处理的错误升级为 unhandledRejection → 进程退出。错误处理路径反而成了崩溃路径。
- 推荐修复：三处各加 `.catch(logError)`。
- 推荐原因：一行级修复，与文件内既有模式对齐。

> **【审计 2026-07-31】完全准确。**
>
> `grep -n 'executeStopFailureHooks' src/query.ts` → import 在 :100，调用点精确在
> **1468 / 1475 / 1557**，三处均为 `void executeStopFailureHooks(lastMessage, toolUseContext)` 无 `.catch`。
> `:581` 的对照写法确实存在（581-584 的 `void recordContentReplacement(…).catch(logError)`，
> 在 `applyToolResultBudget` 的回调参数里）—— 是 `void …catch(logError)` 同构模式，但不是 hook 调用，
> 引用时说明清楚更佳。
>
> 补充：`executeStopFailureHooks` 内部虽然最终 await 的是不会 reject 的 `executeHooksOutsideREPL`，
> 但它在 await 之前有一段同步前置（`getAppState()`、`getSessionId()`、`hasHookForEvent()`、
> `extractTextContent()`、`createBaseHookInput()`，`hooks.ts:3743-3771`），
> 这些在 async 函数里抛错即为 rejection —— 触发路径比 #1 窄但真实存在。

### 3. sessionStorage.drainWriteQueue 无失败保护 —— 磁盘错误三重损害

- 位置：`src/utils/sessionStorage.ts:660-701`
- 问题：`appendToFile` 二次失败（ENOSPC/EACCES）时异常传播到无 catch 的 `setTimeout(async ...)` 回调 → 进程退出；且 (a) batch 已 splice 出队，transcript 永久丢失；(b) 该 batch 所有 `resolve` 永不调用，`QueryEngine.ts:459` 的 `await transcriptPromise` 永久挂起；(c) `activeDrain` 残留 rejected promise 污染后续 flush。
- 推荐修复：per-file 循环体包 try/catch，失败时仍调用所有 resolvers（释放等待方）+ `logError`，单文件失败不中断其他文件 drain。
- 推荐原因：写盘是长会话必经路径，ENOSPC 在真实环境可发生；修复只加强失败路径，不改成功路径语义。

> **【审计 2026-07-31】完全准确，三重损害逐条证实。**
>
> - 范围 `660-701` 精确，`drainWriteQueue` 无 try/catch，结尾即 "Clean up empty queues" 循环。
> - `appendToFile`（~648-658）确实是 try `fsAppendFile` → catch → `mkdir` → `fsAppendFile`，**二次失败向外传播**。
> - 进程退出路径成立：`scheduleDrain`（~632-646）的 `setTimeout(async () => { … this.activeDrain = this.drainWriteQueue(); await this.activeDrain; this.activeDrain = null; … })` 无 catch。
> - (a) 数据丢失成立：`const batch = queue.splice(0)` 已出队。
> - (b) 永久挂起成立：resolver 由 `enqueueWrite`（~614-630）的 `new Promise<void>(resolve => …)` 持有，
>   `QueryEngine.ts:459` 的 `await transcriptPromise` 精确存在（:455 创建、:457 `void`、:459 `await`）。
> - (c) `activeDrain` 污染成立：`flush()`（~864-884）开头 `if (this.activeDrain) { await this.activeDrain }`，
>   因 `activeDrain = null` 被跳过而 await 到一个已 rejected 的 promise。

### 4. mcp-client withConnectionTimeout：onTimeout 抛错则调用方永远挂起

- 位置：`packages/mcp-client/src/connection.ts:92-95`
- 问题：`setTimeout(async () => { await onTimeout(); reject(...) })` —— `onTimeout()`（transport 清理，可能抛）一旦 reject，`reject(...)` 永不执行，外层 `Promise.race` 无限等待，同时产生 unhandledRejection。MCP server 连接挂死直接传导到 CLI 启动。
- 推荐修复：`try { await onTimeout() } finally { reject(...) }`。
- 推荐原因：超时语义的本分就是"一定 settle"，修复是语义纠错而非行为变更。

> **【审计 2026-07-31】机制正确，但影响链不成立 —— 该函数全仓库零调用点。**
>
> 代码机制描述一字不差：executor 已同步返回，`onTimeout()` reject 后 `reject(...)` 永不执行，
> `timeoutPromise` 永不 settle，`Promise.race([connectPromise, timeoutPromise])` 无限等待。
>
> 但 `withConnectionTimeout` 只有定义和 re-export，**没有任何调用方**：
> ```
> packages/mcp-client/src/connection.ts:84   ← 定义
> packages/mcp-client/src/index.ts:94        ← re-export
> （repo-wide grep 无其他引用；.superpowers/ 下的命中是 baseline 快照副本）
> ```
> 因此"MCP server 连接挂死直接传导到 CLI 启动"没有路径支撑。
>
> **结论**：这是库内死代码的语义缺陷。修复值得做（3 行、语义纠错、防止未来接入时踩坑），
> 但 **P0 定级不成立** —— 当前无运行时可达性。

### 5. ide.ts VSIX 下载手写 pipe 不转发源流错误 —— 永久挂起 + fd 泄漏

- 位置：`src/utils/ide.ts:1450-1455`
- 问题：Node `pipe()` 不转发源流 error；`vsixResponse.data` 出错时 promise 等不到 `finish`/`error`，`await` 永久挂起，fd 不关闭、临时文件不清理。
- 推荐修复：`await pipeline(vsixResponse.data, writeStream)`（`stream/promises`），一行替换。
- 推荐原因：确定性缺陷，标准库 `pipeline` 语义完全等价且正确传播双向错误。

> **【审计 2026-07-31】准确。仅"一行替换"需修正为两行。**
>
> `ide.ts:1449-1455` 的手写 promise 与描述一致，`vsixResponse.data`（源流）的 error 无监听。
> 但 `ide.ts` 现有 29 条 import 中**没有** `stream/promises` 或 `pipeline`，
> 需新增 `import { pipeline } from 'stream/promises'` —— 是两行改动，不是一行。

## P1 — 输入校验与一致性缺陷（建议修复）

### 6. BashTool `timeout` 参数无上限钳制，与 prompt 契约不符

- 位置：`packages/builtin-tools/src/tools/BashTool/BashTool.tsx:1016`
- 问题：`const timeoutMs = timeout || getDefaultTimeoutMs()`；Zod schema 与 validateInput 均不检查 timeout，而 prompt.ts:333 明确告诉模型上限是 `getMaxTimeoutMs()`（10 分钟）——承诺了但没强制执行。模型传超大值可让失控进程挂住 shell 一整天，负数原样流入定时器。
- 推荐修复：`Math.min(Math.max(timeout ?? getDefaultTimeoutMs(), 1), getMaxBashTimeoutMs())`。
- 推荐原因：唯一外部输入（模型输出）无校验直接控制资源生命周期的点；合法用法本就 ≤ max，钳制不改变任何合法行为。

> **【审计 2026-07-31】主体准确。三点修正 + 一条被漏掉的仓库内先例。**
>
> 证实部分：`BashTool.tsx:1016` 为 `const timeoutMs = timeout || getDefaultTimeoutMs()`；
> zod 只在 `.describe()` 文案里提 max（`:305`），`semanticNumber` 仅做数字字符串强转、无范围校验
> （`semanticNumber.ts:26-35`）；`validateInput`（`:659`）只检查 sleep pattern，不碰 timeout；
> `prompt.ts:333` 确实向模型承诺了上限。`timeoutMs` 经 `exec()` → `Shell.ts:196`
> `timeout || DEFAULT_TIMEOUT` → `ShellCommand.ts:294` `setTimeout(…, this.#timeout)`，链路无钳制。
>
> 1. **两个函数名都真实存在，不是笔误，但选错会挂 CI。**
>    `getMaxBashTimeoutMs` 在 `src/utils/timeouts.ts:28`；`getMaxTimeoutMs` 是
>    `BashTool/prompt.ts:31` 的 wrapper（内部转调前者），且 `BashTool.tsx:66` **已经 import 了它**。
>    直接 import `getMaxBashTimeoutMs` 会给 `builtin-tools` 新增一条 `from 'src/...'` 反向导入，
>    触碰按包边界棘轮（基线 `builtin-tools: 1206`，只减不增）→ `bun run precheck` 失败。
>    **应使用文件内已有的 `getMaxTimeoutMs()`。**
> 2. **"负数原样流入定时器"字面为真，但后果描述有误。**
>    `timeout || default` 保留 `-1`（真值），确实流到 `setTimeout`；但 Node 把 ≤0 的 delay 钳成 1ms，
>    结果是**立即超时**，不是"挂住 shell 一整天"。后半句只对超大正数成立。
>    下界钳制仍应保留（把立即超时纠正为合法值）。
> 3. **漏了仓库内既有先例（这条反而加强本项论证）。**
>    `PowerShellTool.tsx:807` 已经是
>    `const timeoutMs = Math.min(timeout || getDefaultTimeoutMs(), getMaxTimeoutMs())`。
>    同类工具一个钳制一个不钳制 —— 是标准的实现漂移。顺带：PowerShell 侧缺下界钳制，同样存在负数问题。

### 7. `API_TIMEOUT_MS` 解析四处逐字重复，且全部存在 NaN 直传缺陷

- 位置：`src/services/api/client.ts:144`、`openai/client.ts:62`、`grok/client.ts:34`、`openai/responsesAdapter.ts:1336-1339`
- 问题：`parseInt(process.env.API_TIMEOUT_MS || ...)` —— 用户设非法值（如 `abc`）时 `parseInt` 返回 NaN 直接作为 SDK timeout，所有请求瞬间超时且无报错指向原因。同仓库 `claude.ts:839-842` 已有带 NaN 防护的正确实现——漂移已实际发生（第五处修了 bug，其余四处没跟上）。
- 推荐修复：提取 `getApiTimeoutMs()`（NaN/非正数落回默认），四处统一调用。
- 推荐原因：同时具备重复（4 处）、魔法值（`600 * 1000`）、真实 bug（NaN）三重问题；收敛为一个导出函数 + 4 行替换。

> **【审计 2026-07-31】"四处全部存在 NaN 缺陷"为假，漂移叙事为假。本条需重写。**
>
> 1. **实际只有三处裸奔。** `responsesAdapter.ts` 在**消费点**已经挡住了：
>    ```ts
>    const timeoutMs = parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10)   // :1336-1339
>    const { signal, cleanup } = createCombinedAbortSignal(params.signal, {
>      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 600_000,                     // :1341 ← 已有防护
>    })
>    ```
>    真正 NaN 直传的是 `client.ts:144`、`openai/client.ts:62`、`grok/client.ts:34`（各自直接
>    `timeout: parseInt(...)` 交给 SDK）。responsesAdapter 只剩重复与魔法值问题，不是 bug。
> 2. **`claude.ts` 不是"同一函数的正确实现"，不能统一。** 该处（准确行号
>    **839-843**，原文写 839-842）是 `getNonstreamingFallbackTimeoutMs()`：
>    ```ts
>    const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
>    if (override) return override
>    return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? 120_000 : 300_000
>    ```
>    默认 **300s / 远程 120s**，不是 600s；语义是"非流式回退超时"，与三处的"SDK client timeout"不同。
>    把它并入一个 `getApiTimeoutMs()` 会改掉它的行为 —— 违反"不改变现有功能"约束。
>    另外它的守卫是 `if (override)`：挡住 NaN 和 0，**负数照样通过**，所以也不是"带 NaN 防护的正确实现"的完整版。
> 3. **因此"第五处修了 bug、其余四处没跟上"的漂移叙事不成立。** 五处是三种不同东西：
>    3 处真缺陷、1 处仅重复（responsesAdapter）、1 处不同语义不同默认值（claude.ts）。
>
> **修正后的推荐**：提取 `getApiTimeoutMs()`（NaN / 非正数落回 600s），替换 **client.ts:144、
> openai/client.ts:62、grok/client.ts:34** 三处；responsesAdapter 可选择性改用它以消除魔法值
> （行为等价，其 `Number.isFinite` 兜底可同时删除）；**claude.ts 不动**。

### 8. sideQuery 非流式路径吞掉工具参数 JSON.parse 错误，静默以 `{}` 执行工具

- 位置：`src/utils/sideQuery.ts:770-773`
- 问题：Grok/非流式 OpenAI 路径中 `JSON.parse(fn.arguments)` 失败被空 catch 吞掉，`input` 变 `{}`，工具**带空参数真实执行**；流式路径（responsesAdapter）有专门 soft-fail 处理，两条路径行为不一致。
- 推荐修复：catch 中加 `logForDebugging` 记录原始错误（保守方案）；与流式路径 soft-fail 语义对齐为后续可选项。
- 推荐原因：唯一直接影响运行时正确性的问题；保守方案零行为变化，先解决"无日志无法排查"。

> **【审计 2026-07-31】"两条路径行为不一致"说反了，且缺陷是同文件两处。本条需重写。**
>
> 1. **`responsesAdapter` 的 soft-fail 不是工具参数的。** 该文件仅两处 `JSON.parse`（`:506` / `:511`），
>    是 **SSE 信封**解析的 soft-fail，与工具参数无关。工具参数在流式路径里是通过
>    `response.function_call_arguments.delta` 拼字符串（`:1089-1093`），**不在 responsesAdapter 里 parse**。
> 2. **流式路径的真正对应点在同一个文件，行为完全相同（同样静默）：**
>    ```
>    src/utils/sideQuery.ts:536-543   // 流式累积路径
>      let parsed: unknown = {}
>      try { parsed = JSON.parse(rawInput) } catch { parsed = {} }   ← 静默，无日志
>
>    src/utils/sideQuery.ts:770-773   // 非流式路径（本条原文所指）
>      let input: unknown = {}
>      try { input = JSON.parse(fn.arguments || '{}') } catch {}     ← 静默，无日志
>    ```
>    两条路径都是"静默以 `{}` 真实执行工具"，**一致而非不一致**。
> 3. **缺陷（无日志）真实存在，但是两处。** 只补 `:772` 会**制造**原文误以为已存在的那种不一致。
>
> **修正后的推荐**：两处 catch 各加 `logForDebugging`（`sideQuery.ts:32` 已 import，无需新增），
> 保持"以 `{}` 继续"的现有行为不变。

---

## 已审计但明确【不推荐本次修复】的项

| 候选项 | 原因 |
|---|---|
| `removeMessageByUuid` tombstone 与写队列竞态（sessionStorage.ts:894） | 真实问题，但修复需引入 per-file 串行通道，触及 transcript 写入核心语义，风险大于收益，建议单独专项 |
| 126 文件运行时 SCC（query/tools/hooks/mcp 死结） | 架构债，需逐边拆解长期推进，非一次性修复 |
| `startDeferredPrefetches` 下沉拆 main.tsx 循环 | 值得做但属独立小重构，不混入缺陷修复批次 |
| fileHistory v1 备份覆写竞态 | 需并发编辑同一文件才触发，COPYFILE_EXCL 修复简单但优先级低于上述 8 项 |
| searchTools 每次全量重算 idf | 纯性能优化，工具数少时无感，可后续顺手做 |
| `errorMessage()` 44 处手写三元替换 | 机械替换收益低、churn 大，不值得单独批次 |
| 大文件拆分（REPL.tsx 6695 行等） | decompiled 代码需保持与上游结构对应，风险大于收益 |
| type-only import 循环清洗（1341 文件） | 无运行时成本，churn 数百文件，不值得 |

> **【审计 2026-07-31】表内数字核对**
>
> | 声明 | 核对结果 |
> |---|---|
> | `removeMessageByUuid`（sessionStorage.ts:894） | ✅ 精确，函数签名在 :894 |
> | `REPL.tsx 6695 行` | ✅ 精确（`wc -l` = 6695） |
> | `searchTools` 每次全量重算 idf | ✅ 精确，`toolIndex.ts:137` 建索引 + `:168` 每次查询各调一次 `computeIdf` |
> | fileHistory v1 备份覆写竞态 / `COPYFILE_EXCL` | ✅ 精确，`fileHistory.ts:780` / `:784` 为裸 `copyFile`，无 `COPYFILE_EXCL` |
> | `errorMessage()` **44 处**手写三元 | ❌ **低估约 4 倍**。`instanceof Error ? x.message : String(...)` 精确匹配 **157** 处，宽匹配（`instanceof Error ? …message`）**203** 处。helper 存在于 `errors.ts:133`。结论（不值得单独批次）不变，反而更强 |
> | 126 文件运行时 SCC | ⚠️ 未独立验证（需复现原始依赖图工具） |
> | type-only import 循环 1341 文件 | ⚠️ 未独立验证（同上） |

## 修复执行计划

P0（1-5）+ P1（6-8）共 8 项全部按上述推荐方案执行，预计修改约 8 个文件、10 处函数级改动。每处均为局部、最小化、不改变现有功能的修复。完成后运行 `bun run precheck`（typecheck + lint + test）验证零错误。

> **【审计 2026-07-31】计数与定级修正**
>
> - **文件数低估**：按修正后方案实际触及 **10 个已有文件 + 1 个新模块 = 11 个**
>   （skillChangeDetector、query.ts、sessionStorage、mcp connection、ide、BashTool、
>   api/client、openai/client、grok/client、sideQuery + `getApiTimeoutMs` 新模块）；
>   若 #7 顺带清理 responsesAdapter 的魔法值则为 12。原文"约 8 个"偏低。
>   若采纳 #1 批注里的 `print.ts` 浮动 promise 闭环，再 +1。
> - **函数级改动低估**：约 **12-13 处**（#8 为两处、#1 若含 print.ts 为两处），非 10 处。
> - **定级修正**：#1 与 #4 均无当前可达的崩溃/挂起路径（见各条批注），
>   实际 P0 只剩 **#2、#3、#5** 三项。#1/#4 建议归入"防御性加固/语义纠错"。
> - **优先级建议（修正后）**：
>   1. #3 sessionStorage（唯一在常规长会话路径上、三重损害俱全）
>   2. #5 ide.ts（确定性缺陷 + fd 泄漏）
>   3. #2 query.ts（一行 ×3，错误处理路径反成崩溃路径）
>   4. #6 BashTool 钳制（注意必须用 `getMaxTimeoutMs()`，否则挂边界棘轮）
>   5. #7 三处 NaN + #8 两处日志 + #1/#4 加固
