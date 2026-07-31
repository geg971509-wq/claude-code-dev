# 对照 kimi-code 的可借鉴设计 — 决策清单

> 调研方式：三个维度并行对照（模块化/耦合、复杂度/冗余/过度设计、资源管理/正确性/鲁棒性），所有结论均经实际读码验证，附双方仓库真实文件路径。
> 对照仓库：`/Volumes/work/software/install/kimi-code`（Moonshot 官方开源 Kimi Code CLI，pnpm monorepo）。
> 状态：**已判决（2026-07-29 事实审计）**。实现范围锁定 **≤3 项**：1A / 2A / 3A。其余明确推迟或改写，不进入本轮实施。

## 审计说明（本轮）

- 对照路径与行号已在 2026-07-29 对两侧仓库复读；下列「事实修订」是相对原稿的更正。
- 既往 kimi 借阅（Goal / Provider FinishReason+errors / Wire RCS·ACP codes）已落地；**不**再把 wire 注册表当 greenfield 重做。
- 借阅上限：本轮最多锁 3 项可实施项（见历史反馈 borrow-at-most-three）。

## 决策清单（按推荐优先级排序）

### 1. 进程两阶段终止：SIGTERM → 宽限期 → SIGKILL 〔维度 02/05〕

- **kimi-code**：`packages/agent-core/src/agent/background/index.ts:964` — 先 SIGTERM，宽限 `SIGTERM_GRACE_MS = 5_000` 未退出才 SIGKILL；`packages/agent-core/src/agent/background/process-task.ts:49-56` abort 只发 SIGTERM，`forceStop()`（约 :80）才升级 SIGKILL。
- **本仓库**：`src/utils/ShellCommand.ts:337` `#doKill()` **无条件** `treeKill(pid, 'SIGKILL')`。超时路径 `#handleTimeout` 调用 `#doKill(SIGTERM)`（:139）——参数只影响 **exit code 常量**（`SIGTERM=143`），实际信号仍是 SIGKILL。进程没有清理窗口。
- **事实**：原稿正确。
- **选项**：A. 采纳（宽限 1–2s，避免中断体验回退）｜B. 不采纳
- **判决：A**。改动局部（一个方法），正确性收益实在。
- **成本：小**。

### 2. Transcript 原子重写 + 写队列失败可上报 〔维度 05/06〕

- **kimi-code**：`packages/agent-core-v2/src/_base/utils/fs.ts:79` `atomicWrite`（tmp+fsync+rename+失败清理）；`persistence/backends/node-fs/appendLogStore.ts` 写失败 sticky + `onError`，读取容忍末行撕裂，rewrite 与并发 append 串行化。
- **本仓库**：
  - `src/utils/sessionStorage.ts:966` tombstone 慢路径对整个 transcript **非原子** `writeFile`（崩溃可半截）；
  - `:1645`、`:1697` 远端 hydrate 同样直接截断写；
  - `enqueueWrite`（:613–629）队列 ≥1000 时 `splice` 丢最旧并 **静默 `resolve()`**，无 log；
  - 多数 `appendEntry` 路径 `void this.enqueueWrite(...)`（fire-and-forget）；
  - `drainWriteQueue`（:659–700）本身无 try/catch，`scheduleDrain` 的 `setTimeout(async () => …)` 也不 catch —— 失败更像 unhandled rejection / 静默丢数据，而非结构化上报。
- **已有先例**：`src/utils/file.ts` `writeFileSyncAndFlush_DEPRECATED`（tmp+rename）、`zipCache.atomicWriteToZipCache` 等。
- **事实修订**：原稿机制判断成立；「drain 失败 fire-and-forget」表述保留，但精确说法是 **无 onError/无 sticky + enqueue 侧 void**。
- **选项**：A. 只做原子重写（局部）｜B. 原子写 + sticky 失败 + onError 全做｜C. 不做
- **判决：A**（本轮不做 B）。真实损毁面在 rewrite/hydrate 全量写；队列 sticky 是另一套语义，单独立项。
- **成本：A 小 / B 中**。

### 3. Abort 辅助原语 + 类型化取消原因 〔维度 06/01〕

- **kimi-code**：`packages/agent-core-v2/src/_base/utils/abort.ts`（98 行）— `abortable()`、`linkAbortSignal()`（转发 `signal.reason`）、`createDeadlineAbortSignal()`、`UserCancellationError`。取消原因沿链路传播：`packages/agent-core/src/agent/turn/index.ts:341-349` `abortTurn` 注释写明设计意图；v2 subagent 路径用 `linkAbortSignal`（如 `runAgentTurn.ts`）。
- **本仓库**：取消原因是字符串魔法值 `abort('interrupt')`（`REPL.tsx:5213`、`print.ts:1916`、`handlePromptSubmit.ts:341`），消费端 `signal.reason === 'interrupt'`（`ShellCommand.ts:189`、`StreamingToolExecutor.ts:267`）；超时散落手写 `Promise.race`。
- **事实修订**：原稿「`turn/index.ts:341-349`」未写包路径；正确路径是 **agent-core**（不是 agent-core-v2）。语义正确。
- **选项**：A. 移植 helper 模块，新代码先用，存量渐进替换｜B. 全量替换 `'interrupt'` 字符串｜C. 不做
- **判决：A**。`'interrupt'` 有「不杀进程转后台」特殊语义，全量替换风险 > 收益。
- **成本：小–中**。

### 4. 统一错误码注册表，扩展 wire-types 为契约包 〔维度 05/07〕

- **kimi-code**：`packages/agent-core/src/errors/codes.ts` — `domain.reason` + 元数据；`packages/protocol` + `packages/klient/test/contract-parity.ts`。
- **本仓库（修订后）**：
  - `src/utils/errors.ts` 仍有零散 Error 子类；MCP 等仍消息嗅探（`packages/mcp-client/src/connection.ts:256` `error.message.includes('Maximum reconnection attempts')`）——成立。
  - **`packages/wire-types` 已不是「无码表」**：`src/errorCodes.ts` 已有 27 个 `WireErrorCode`（`domain.reason`），另有 `closeCodes.ts` / `errorPayload.ts` / `index.ts`（源码 4 模块 + 测试）。**无 zod schema** 仍真。
  - 历史锁定（2026-07-20）：Wire 仅服务 RCS/ACP `error.type` / JSON-RPC `error.data`；**明确不做** full protocol / klient parity。
- **事实修订**：原稿「只有 4 个文件、无 schema」半对半错——文件数近似，但 **已有码表**；「扩展为契约包」与既往拒绝项冲突。
- **选项**：A. 只在热点路径扩码（MCP + API，接到现有 `WireErrorCode` 或平行应用码表）｜B. 错误码 + wire-types schema 化 + parity 测试｜C. 不做 / 维持 wire 现状
- **判决：C（本轮）**；若后续单独立项，只允许 **A 的窄扩**，禁止 B（schema/parity/全协议）。
- **成本：A 中 / B 中大**。

### 5. 运行时 FlagResolver 补充编译期 `feature()` 〔维度 01/07〕

- **kimi-code**：`packages/agent-core/src/flags/resolver.ts`（99 行）— 4 级优先级（master `KIMI_CODE_EXPERIMENTAL_FLAG` > per-flag env > config.toml `[experimental]` > registry 默认），`explainAll()` / `setConfigOverrides()`。
- **本仓库（修订后）**：
  - **注册表一处**：`src/constants/featureFlags.ts` → `FEATURE_FLAGS` **94** 项（非「定义散落三处」）。
  - **默认启用列表**：`scripts/defines.ts` `DEFAULT_BUILD_FEATURES` **43** 项（**不是 65**）；`build.ts` 合并 `FEATURE_*` env；`scripts/vite-plugin-feature-flags.ts` 复用同一列表。
  - `feature()` 调用全仓约 **875–992** 处（原稿「911」量级可接受，非精确锁定）。
  - `feature()` 仍受 Bun 限制（仅 if/三元条件位）；dev 全开 vs build 默认 43 不一致；`src/tools.ts` 混用 `feature()` / `USER_TYPE` / `process.env` 三种 gating —— 成立。
- **事实修订**：flag 数 94 对；「定义三处 + build 开 65」错，已改正。
- **选项**：A. 移植 FlagResolver，行为级 gate 走它，`feature()` 保留 import 级 DCE｜B. 全量替换调用点｜C. 维持现状
- **判决：C（本轮推迟）**。有用但非正确性 P0；B 明确否决（丢 DCE）。需要 explain 时再开 A。
- **成本：中（可增量）**。

### 6. `bootstrap/state.ts` 去单例化：显式初始化 + 参数注入 〔维度 07/02〕

- **kimi-code**：`packages/agent-core-v2/src/_base/di/` 完整 DI（`LifecycleScope` 等，**不建议照搬**）；`lifecycle.ts` 内 `DisposableStore`/`toDisposable` 可用子集约百行量级（整文件约 665 行，勿把整文件当「100 行原语」）。
- **本仓库**：`src/bootstrap/state.ts` 模块级 `const STATE = getInitialState()`，加载时 `realpathSync` + `randomUUID` —— 仍是测试 mock 污染根源。
- **事实**：问题成立；成本与架构风险也成立。
- **选项**：A. 显式 session context，热路径分批迁移｜B. 完整 DI｜C. 不动
- **判决：C（本轮）**。B 与既往「拒绝 DI/agent-core-v2 rewrite」一致；A 是中大型重构，不塞进 ≤3 正确性借阅。
- **成本：中–大**。

### 7. 权限决策：有序策略链替代单体决策函数 〔维度 01/03/04〕

- **kimi-code**：`packages/agent-core/src/agent/permission/policies/` — 有序 policy（首个非 undefined 获胜）；单文件约 11–172 行；`permission/index.ts` 编排 **320** 行；权限核心合计 **~1444** 行。
- **本仓库（修订后）**：
  - `hasPermissionsToUseTool` 外层约 **511** 行（:471 起）；`hasPermissionsToUseToolInner` 另约 **171** 行（:1177）；`// 1a/1b/1c` 出现在 rule-based / inner 路径。
  - `src/utils/permissions`：**24** 个非测试 `.ts`，约 **9392** 行（原稿「24 文件 / 10957 行」略高；含测试约 32 文件 / ~10700 行）。再含 `components/permissions` 会大很多——对比应用 utils 核心即可。
- **事实修订**：结构判断成立；行数改为实测。
- **选项**：A. 新逻辑 policy 化、存量渐进｜B. 一次性等价重构｜C. 不动
- **判决：C（本轮）**；B 永久不建议。安全路径 + 反编译代码库，无充分回归网前不动。
- **成本：大（A 可控）**。

### 8. 延迟工具加载：公告 + 按名加载替代 TF-IDF 管道 〔维度 03/04/01〕

- **kimi-code**：`packages/agent-core/src/tools/builtin/select-tools.ts`（130 行）；连同 `dynamic-tools.ts` / `tools-diff.ts` 等约 **330+** 行（原稿「全套约 430」量级可接受）。历史消息即已加载集合真源。
- **本仓库（修订后）**：
  - 主栈约：`toolIndex.ts` 233 + `prefetch.ts` 156 + `utils/searchExtraTools.ts` **720** + `SearchExtraToolsTool.ts` 602 + `ExecuteTool` ~327 + `constants/tools.ts` 179 ≈ **~2200** 行核心（加 hint/hook/测试才接近或超过 2600）。「8 个文件 / 2600+」偏高但方向对。
  - `CORE_TOOLS`（`src/constants/tools.ts:137`）实测 **约 30** 个名字（含 Bash+Shell），**不是 38**（CLAUDE.md 旧表述亦过期）。
- **事实修订**：行数与 CORE_TOOLS 计数已改。
- **选项**：A. 混合：搜索做发现，加载改公告+按名｜B. 全量照搬 kimi｜C. 维持现状
- **判决：C（本轮）**；若再开必须先 faux eval（`src/evals/runner.ts`），且只考虑 A。B 否决（大 MCP 池丢发现性）。
- **成本：中**。

## 已排查但未列入的（诚实记录）

- **App 薄壳化 / SDK 门面层**：方向正确成本大。`src/components` 中 `from 'src/services/...'` 命中 **72** 个文件（原稿 72 对）。kimi `apps/kimi-code`「88 处 import 全走 SDK」**未复核为真**（`@moonshot-ai/*` 单独已 300+ import）——删掉该精确数字，只保留「门面层方向正确」。
- **Disposable 原语**：可作为项 6 附带，不单列；勿把整个 `lifecycle.ts`（665 行）当成 100 行。
- **循环依赖检查 + scratch 目录**：kimi `.oxlintrc.json` 确有 `"import/no-cycle": "error"`；可随时顺手加棘轮，不单列。
- **TUI 状态管理**：非差距。`src/state/store.ts` **34** 行 —— 对。
- **流式/provider 适配层**：总量可比；不构成 kimi 更简洁。
- **changesets / publint / attw / api-extractor**：不发布包，跳过。
- **MCP 连接生命周期、settings.json 原子写**：settings 经 `writeFileSyncAndFlush_DEPRECATED`（tmp+rename）；MCP 有 generation/重连 —— 与 kimi 相当，不构成差距。

## 最终判决（锁定）

| 项 | 判决 | 本轮实施？ | 备注 |
|---|---|---|---|
| 1 两阶段 kill | **A** | **是** | 正确性 P0，局部 |
| 2 transcript 原子写+上报 | **A**（仅原子重写） | **是** | 不做 sticky/onError |
| 3 abort 原语 | **A** | **是** | helper 先落，不换 `'interrupt'` 语义 |
| 4 错误码/契约 | **C** | 否 | wire-types 已有；禁全协议；热点扩码另立 |
| 5 FlagResolver | **C** | 否 | 推迟；禁全量替换 feature() |
| 6 去单例化 | **C** | 否 | 禁 DI 容器；大迁移另立 |
| 7 权限策略链 | **C** | 否 | 禁一次性重构 |
| 8 延迟工具加载 | **C** | 否 | 先 eval 再议 A |

**本轮实施包：1A → 2A → 3A**（建议顺序：kill → transcript 原子写 → abort helpers）。未授权前不改代码。

## 决策记录

| 项 | 决策（选项字母） | 备注 |
|---|---|---|
| 1 两阶段 kill | A | 2026-07-29 锁定 |
| 2 transcript 原子写+上报 | A | 仅原子重写；B 推迟 |
| 3 abort 原语 | A | 渐进；保留 interrupt 语义 |
| 4 错误码/契约 | C | wire 已存在；非 greenfield |
| 5 FlagResolver | C | 本轮不做 |
| 6 去单例化 | C | 本轮不做 |
| 7 权限策略链 | C | 本轮不做 |
| 8 延迟工具加载 | C | 本轮不做；先 eval |
