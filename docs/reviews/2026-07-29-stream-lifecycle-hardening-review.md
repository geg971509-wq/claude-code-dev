# 代码审查：fix/stream-lifecycle-hardening 工作区改动

- 日期：2026-07-29
- 范围：当前工作区未提交改动（`git diff` + 未跟踪新文件），约 35 个文件、+1048/-469 行
- 前提：不改变代码功能、不新增软件功能，仅从工程角度/代码质量/条件竞争等方面提出改进点
- 总体结论：改动整体质量高（faux/evals 设计闭环、IIFE 重构无引用遗漏、测试无 mock 污染、CLAUDE.md 与代码一致），以下为筛出的 8 个实质性问题，每条附选项与推荐，供决策。

---

## 1. `query.ts:324-338` 外层 catch 与它声称 mirror 的 model_error 路径不对等

**分类**：05 正确性 / 06 闭环 | **严重程度**：中

新增的外层 catch 只做 `logError` + yield 错误消息，而内层 model_error 路径（`query.ts:1220-1264`）还做两件事：

- 补悬空 tool_result（`yieldMissingToolResultBlocks`）
- 发 `tengu_query_error` / `logAntError` 遥测

外层捕获的恰恰是工具循环（1686-1709）、`handleStopHooks`（1564）、attachments（1906）逃逸的错误——此时 transcript 极可能已有未配对 tool_use 且部分消息已持久化，strict mode（HFI）下 `ensureToolResultPairing`（`src/services/api/claude.ts:1344`）会直接 throw 卡死会话；且这条"防未知 bug"的路径发生后完全无遥测，与本分支 hardening 目标相悖。注释中 "Mirroring queryLoop's model_error terminal" 名不副实。

**选项**：

- A. 外层对齐内层（补 tool_result 配对 + 遥测）—— **推荐**：这才是真正的 "mirror"
- B. 只补遥测，配对交给下次请求的 `ensureToolResultPairing`（改动最小，strict mode 风险保留）
- C. 把内层 try 扩大到工具循环，复用同一路径（最彻底但 diff 最大）

---

## 2. `BashTool.tsx:533-537` sed 编辑的并发覆盖窗口被注释固化为 wontfix

**分类**：06 闭环 / 05 正确性 | **严重程度**：中

注释自证：权限对话框打开期间（时长无上限）外部对文件的修改会被 `writeTextContent` 静默覆盖，且与 FileEditTool/FileWriteTool 不同，这里没有 readFileState staleness 检查。但兄弟工具在完全相同情形下抛 `FILE_UNEXPECTEDLY_MODIFIED_ERROR`（`FileEditTool.ts:466`、`FileWriteTool.ts:300`）——"补检查"才是一致行为，当前状态才是不一致的那个。注释把不修的理由定性为 "closing it is a behavior change"，站不住脚。

**选项**：

- A. 复用 FileWriteTool 的 readFileState 时间戳 + 全量内容比对模式 —— **推荐**：真实数据丢失路径，且模式现成
- B. 维持注释 wontfix（理由：关闭它是行为变更，超出本分支范围）

---

## 3. `rawStreamLogger.ts:144-149` resume 后"进入即超 cap"分支静默停日志

**分类**：06 鲁棒性 | **严重程度**：中

crossing 分支（152-162 行）会追加 `log-capped` marker 解释日志为何停止，但 resume 时文件已超限（如旧版本 CLI 无 cap 写出的 2GB 文件）直接 `capReached = true; return`，文件里没有任何线索，日志无声消失。现有测试（`__tests__/rawStreamLogger.test.ts:556`）特意预置低于 cap 的文件，走 crossing 分支，恰好没覆盖这个分支。

**选项**：

- A. 该分支置 `capReached` 前也 append 一次 `log-capped` marker（不受 cap 判断拦截）+ 补预置文件已超 cap 的测试 —— **推荐**：一行改动消除一个排查黑洞
- B. 不动（旧版文件场景罕见）

---

## 4. `rawStreamLogger.ts:222-235` `maxEntryBytes` 名不副实（字符/字节语义混淆）

**分类**：05 正确性 | **严重程度**：中/低

`serialized.length` / `payload.length` / `slice(0, limit)` 都按 UTF-16 code unit 计，常量却叫 `MAX_LOG_ENTRY_BYTES`：

- CJK/emoji 密集的事件实际落盘字节可达 cap 的 ~3 倍；`bytes` 字段上报的也是字符数而非字节数
- 截断行 = limit 长度的 preview + metadata（sessionId/streamId/route/...）+ preview 二次 JSON 序列化的转义膨胀，截断后反而**不保证 ≤ cap**，最坏接近 2×limit

新测试 `rawStreamLogger.test.ts:481` 的 `expect((logged.preview as string).length).toBe(200)` 还把字符语义锁死了。

**选项**：

- A. 改 `Buffer.byteLength` 口径，preview 预算扣除 metadata 开销，截断后做字节级校验 —— 语义正确但动测试
- B. 常量改名 `maxEntryChars` + 注释说明是近似上限 —— **推荐**：这是 debug 日志，近似上限够用，改名即可消除误导
- C. 不动

附注（同文件低优先项）：文件 cap 的实际 overshoot 依赖 `logOpenAIRawStream` 每 50 事件 `await setImmediate`（438-440 行）给 `bufferedWriter` 的 pendingOverflow 排空机会——跨模块隐式依赖，建议至少在 153 行注释里点名。

---

## 5. `evals/runner.ts:161` 超时只发一次 SIGTERM，无兜底、超时与崩溃不可区分

**分类**：06 鲁棒性 | **严重程度**：中

```ts
killTimer = setTimeout(() => proc.kill(), timeout)
```

- 子进程卡在同步操作时 SIGTERM 无效，`Promise.all([... proc.exited])` 永不 resolve，eval 挂到 bun test 自己的超时，无二级 SIGKILL
- 超时杀死后结果正常返回（`succeeded = true`），调用方只看到非零 exitCode，分不清"超时被杀"和"真实崩溃"

**选项**：

- A. 二级 SIGKILL 定时器 + `EvalResult.timedOut` 标志 —— **推荐**：evals 是测试基建，可观测性值钱
- B. 只加 `timedOut` 标志
- C. 不动

---

## 6. 多处新注释引用的事实已失准

**分类**：07 可维护性 | **严重程度**：低

**(a) 硬编码跨文件行号，提交时已错位**：

- `src/query/stopHooks.ts:57-59` — "query.ts:1553"（实际 1564）、"catch at query.ts:1209"（实际 1220）
- `src/services/tools/StreamingToolExecutor.ts:535-537` — "query.ts:1666"（实际 1676）、"query.ts:1302"（实际 1313）、"try block closes at 1254"（实际 1265）
- `src/utils/queryHelpers.ts:248` — "QueryEngine.ts:415"（实际 404）
- `src/utils/attachments.ts:3046-3047` — "query.ts:1895"（实际 1906）、"catch at query.ts:1209"（实际 1220）

query.ts 这种 2000 行文件行号几乎必然腐烂并误导读者。

**(b) `stopHooks.ts:57-60` 注释论据与同 diff 改动自相矛盾**：注释称 throw 会 "kills the turn silently"，但本次 diff 新增的外层 catch（query.ts:324）恰恰把 throw 转成可见错误消息 + model_error terminal——论据描述的是改动前行为。契约本身（must not throw）仍合理，论据过时。

**(c) `vcr.ts:35-36` 注释因果链错误（已实测验证）**：注释称 guard 防 "faux run under NODE_ENV=test ... subprocesses inherit"，但 `runner.ts:120-136` 的 env 白名单**不包含** NODE_ENV，子进程不会继承。guard 真正保护的是**进程内**场景（bun test 进程里设 `CLAUDE_CODE_USE_FAUX=1` 直接调 `queryModel` 的测试）。错误归因可能误导后人把 NODE_ENV 加进白名单。`smoke.test.ts:27-31` 同样不成立。

**选项**：

- A. 行号引用改为函数名/结构引用（如 "queryLoop 的内层 catch"、"QueryEngine.submitMessage"），同时修正 (b)(c) 两处过时论据 —— **推荐**
- B. 只修正当前行号数值（治标，下次插入又漂移）

---

## 7. `execFileNoThrow.ts:115` 同步 `require` 打破 NoThrow 契约

**分类**：06 鲁棒性 | **严重程度**：低（边缘路径）

`resolveFauxExec` 精心设计为永不抛异常，但：

```ts
const { resolveFauxExec } = require('./fauxExec.js') as typeof import('./fauxExec.js')
```

`require` 这一步不在任何 try/catch 内——若模块加载失败（打包产物缺 chunk、Node 跑 dist 时 `require` 未定义），`execFileNoThrowWithCwd` 会同步抛出，违反 "NoThrow" 契约。触发前提是要先设 `CLAUDE_CODE_USE_FAUX_EXEC=1`，属边缘路径。

**选项**：

- A. require + resolve 包进 try/catch，失败退化为 `{ code: 1, error: '[faux exec] ...' }` —— **推荐**：三行，契约名副其实
- B. 不动（边缘路径）

---

## 8. 小项打包

**分类**：07 工程性 | **严重程度**：低

- **`faux/index.ts:109` turn 推导与 compaction 不兼容**：compaction 把历史 assistant 消息替换为摘要后计数回退，脚本开始回放更旧的轮次——与头注释及 CLAUDE.md "resume/fork/并行 subagent 都能复现同一结果" 的表述在长会话下不成立（resume/fork 确实没问题，compaction 是漏网的一种）。eval 会话短，实际影响小。**建议：只在模块头注释注明限制，不改代码**。
- **`faux.test.ts:18-26` / `fauxExec.test.ts:13-21` 测试 helper 泄漏 /tmp**：`mkdtempSync` 创建的 `faux-*` / `faux-exec-*` 目录从不清理。**建议：afterEach 统一 rmSync**。
- **`sessionStorage.test.ts` 用 `URL.pathname` 读源文件**：不做 percent-decoding，路径含空格/非 ASCII 即 ENOENT。**建议：改 `fileURLToPath(new URL(...))`**。
- **`requestBody.ts:10-15` `KimiReasoningEffort` 类型 import 后无消费**：**建议改 `export type { KimiReasoningEffort } from './kimi.js'`**，删一条无消费绑定。

---

## 已验证无问题的方面（排除项）

- `claude.ts` faux hoist：签名与调用点匹配，位置在所有 provider 分支之前，与 CLAUDE.md 记载一致
- `history.ts`：pasteStore 包装链内部已全量 try/catch，无第二抛出源
- print 模式退出码：`isApiErrorMessage` → QueryEngine `is_error` → print.ts exit 1 链路属实
- `getRemainingResults` 与其新 CONTRACT 相符，tool promise 不 reject
- responsesAdapter.ts 新增 SHAPE 注释与三个构造点、包装链均核对无误
- faux auth guards、`sideQuery` 兜底 throw、`fauxExec` 缓存语义均与文档相符
- FileEdit/FileWrite/NotebookEdit IIFE 重构：内层变量无外层引用，返回解构覆盖全部使用点
- NotebookEditTool 并发检查（validateInput mtime + 写后 readFileState.set）闭环
- 测试改动均为"部分 mock → 真实模块 spread + overrides"加固方向，无断言削弱、无 mock 污染（混跑 12 文件 213 pass / 0 fail）
- CLAUDE.md 与代码一致（行号、兼容路径、export 计数、锁不变式测试组名均核实）
- 已删除的 `tests/mocks/childProcess.ts` 全仓库无残留引用

## 整体建议

- **本次提交前修**：1、2、3、5（正确性/可观测性，不改对外功能）
- **低成本清理**：4、6、7、8 可同批带入，或单独一个 `chore` commit
