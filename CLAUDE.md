# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other AI coding agents when working with code in this repository.

> **单一事实源**：本文件是唯一正文，`AGENTS.md` 是指向本文件的 symlink（借鉴 kimi-code 模式）。只编辑 `CLAUDE.md`，不要把 `AGENTS.md` 替换为独立文件。

## Project Overview

This is a **reverse-engineered / decompiled** version of Anthropic's official Claude Code CLI tool. The goal is to restore core functionality while trimming secondary capabilities. Many modules are stubbed or feature-flagged off. TypeScript strict mode is enforced — **`bun run precheck` 必须零错误通过**（包含 typecheck + lint fix + test）。

## Git Commit Message Convention

使用 **Conventional Commits** 规范：

```
<type>: <描述>
```

常见 type：`feat`、`fix`、`docs`、`chore`、`refactor`

示例：
- `feat: 添加模型 1M 上下文切换`
- `fix: 修复初次登陆的校验问题`
- `chore: remove prefetchOfficialMcpUrls call on startup`

## Commands

```bash
# Install dependencies
bun install

# Dev mode (runs cli.tsx with MACRO defines injected via -d flags)
bun run dev

# Dev mode with debugger (set BUN_INSPECT=9229 to pick port)
bun run dev:inspect

# Pipe mode
echo "say hello" | bun run src/entrypoints/cli.tsx -p

# Build (code splitting, outputs dist/cli.js + chunk files)
bun run build

# Build with Vite (alternative build pipeline)
bun run build:vite

# Test
bun test                                    # run all tests
bun test src/utils/__tests__/hash.test.ts   # run single file
bun test --coverage                         # with coverage report

# Lint & Format (Biome) — 日常开发用 precheck 代替单独调用
bun run lint              # lint check (全项目)
bun run lint:fix          # auto-fix lint issues
bun run format            # format all (全项目)
bun run check             # lint + format check (全项目)
bun run check:fix         # lint + format auto-fix

# Check unused exports
bun run check:unused

# Dependency boundary ratchet（packages → src 反向依赖只减不增）
bun run check:boundaries

# 与官方产物比对漂移（官方发新版后跑一次，非 precheck 的一部分）
bun run check:drift

# Full check (typecheck + lint fix + boundaries + test) — 任务完成后必须运行
bun run precheck

# Remote Control Server
bun run rcs

# Docs dev server (Mintlify)
bun run docs:dev
```

## Architecture

### Runtime & Build

- **Runtime**: Bun (not Node.js). All imports, builds, and execution use Bun APIs.
- **Build**: `build.ts` 执行 `Bun.build()` with `splitting: true`，入口 `src/entrypoints/cli.tsx`，输出 `dist/cli.js` + chunk files。Build 默认启用 19 个 feature（见下方 Feature Flag 段）。构建后自动替换 `import.meta.require` 为 Node.js 兼容版本（产物 bun/node 都可运行）。构建时会将 `vendor/audio-capture/` 和 `src/utils/vendor/ripgrep/` 复制到 `dist/vendor/` 下。
- **Build (Vite)**: `vite.config.ts` + `scripts/post-build.ts`，代码分割模式，chunk 输出到 `dist/chunks/`。post-build 遍历 `dist/` 和 `dist/chunks/` 下所有 `.js` 文件做 `globalThis.Bun` 解构 patch，复制 vendor 文件到 `dist/vendor/`。
- **Vendor 路径解析**: 构建后 chunk 文件位于 `dist/` 或 `dist/chunks/` 下，vendor 二进制在 `dist/vendor/`。`src/utils/distRoot.ts` 提供共享的 `distRoot` 函数，通过 `import.meta.url` 路径中 `lastIndexOf('dist')` 或 `lastIndexOf('src')` 定位根目录。`ripgrep.ts`、`computerUse/setup.ts`、`claudeInChrome/setup.ts`、`updateCCB.ts` 均使用 `distRoot` 而非内联 `import.meta.url` 路径推算。`packages/audio-capture-napi/src/index.ts` 有独立的 `lastIndexOf('dist')` 逻辑，功能等价。
- **为什么 Vite 必须代码分割**: Bun/JSC 会全量解析单个大 JS 文件的 bytecode 和 JIT，单文件 17MB 产物导致 RSS 暴涨至 ~1GB（Node/V8 懒解析仅需 ~220MB）。代码分割为 600+ 小 chunk 后 Bun 按需加载，`--version` RSS 从 966MB 降至 35MB，完整加载从 1GB+ 降至 ~500MB。
- **Dev mode**: `scripts/dev.ts` 通过 Bun `-d` flag 注入 `MACRO.*` defines，并以 `--feature` 启用 `DEFAULT_BUILD_FEATURES`（与 build 同一列表，见 `scripts/defines.ts`），另可用 `FEATURE_<NAME>=1` 追加。裸跑 `bun src/entrypoints/cli.tsx` 不会注入任何 feature（全关）。
- **Module system**: ESM (`"type": "module"`), TSX with `react-jsx` transform.
- **Monorepo**: Bun workspaces — 19 个 workspace packages（含 package.json，经 `workspace:*` 解析）+ 若干辅助目录 in `packages/`。
- **Lint/Format**: Biome (`biome.json`)。覆盖 `src/`、`scripts/`、`packages/` 全项目（含 `packages/@ant/`）。`bun run lint` / `bun run lint:fix` / `bun run format` / `bun run check` / `bun run check:fix`。42 条规则因 decompiled 代码被关闭，仅保留 `recommended` 基线。
- **Pre-commit**: husky + lint-staged。提交时自动对暂存文件执行 `biome check --fix`（TS/JS）和 `biome format --write`（JSON）。
- **CI Lint**: `ci.yml` 在依赖安装后、类型检查前执行 `bunx biome ci .`，lint 或格式化不达标则 CI 失败。
- **Defines**: 集中管理在 `scripts/defines.ts`。版本号从 `package.json` 读取（不再硬编码）。
- **CI**: GitHub Actions — `ci.yml`（lint + 构建 + 测试）、`release-rcs.yml`（RCS 发布）、`update-contributors.yml`（自动更新贡献者）。

### Entry & Bootstrap

1. **`src/entrypoints/cli.tsx`** — True entrypoint。`main()` 函数按优先级处理多条快速路径：
   - `--version` / `-v` — 零模块加载
   - `--dump-system-prompt` — feature-gated (DUMP_SYSTEM_PROMPT)
   - `--claude-in-chrome-mcp` / `--chrome-native-host`
   - `--computer-use-mcp` — 独立 MCP server 模式
   - `--daemon-worker=<kind>` — feature-gated (DAEMON)
   - `remote-control` / `rc` / `remote` / `sync` / `bridge` — feature-gated (BRIDGE_MODE)
   - `daemon` [subcommand] — feature-gated (DAEMON)
   - `ps` / `logs` / `attach` / `kill` / `--bg` — feature-gated (BG_SESSIONS)
   - `new` / `list` / `reply` — Template job commands
   - `environment-runner` / `self-hosted-runner` — BYOC runner
   - `--tmux` + `--worktree` 组合
   - 默认路径：加载 `main.tsx` 启动完整 CLI
2. **`src/main.tsx`** (~5674 行) — Commander.js CLI definition。注册大量 subcommands：`mcp` (serve/add/remove/list...)、`server`、`ssh`、`open`、`auth`、`plugin`、`agents`、`auto-mode`、`doctor`、`update` 等。主 `.action()` 处理器负责权限、MCP、会话恢复、REPL/Headless 模式分发。
3. **`src/entrypoints/init.ts`** — One-time initialization (telemetry, config, trust dialog)。

### Core Loop

- **`src/query.ts`** — The main API query function. Sends messages to Claude API, handles streaming responses, processes tool calls, and manages the conversation turn loop.
- **`src/QueryEngine.ts`** — Higher-level orchestrator wrapping `query()`. Manages conversation state, compaction, file history snapshots, attribution, and turn-level bookkeeping. Used by the REPL screen.
- **`src/screens/REPL.tsx`** — The interactive REPL screen (React/Ink component). Handles user input, message display, tool permission prompts, and keyboard shortcuts.

### API Layer

- **`src/services/api/claude.ts`** — Core API client. Builds request params (system prompt, messages, tools, betas), calls the Anthropic SDK streaming endpoint, and processes `BetaRawMessageStreamEvent` events.
- **7 providers**: `firstParty` (Anthropic direct), `bedrock` (AWS), `vertex` (Google Cloud), `foundry`, `openai`, `gemini`, `grok` (xAI)。
- Provider selection in `src/utils/model/providers.ts`。优先级：modelType 参数 > 环境变量 > 默认 firstParty。

### Tool System

- **`src/Tool.ts`** — Tool interface definition (`Tool` type) and utilities (`findToolByName`, `toolMatchesName`).
- **`src/toolRegistry.ts`** — Tool registry。组装工具清单；工具实现在 `src/tools/`。命名刻意区分：`src/tools.ts` 与 `src/tools/` 只差一个斜杠、含义完全不同，拿错模块不会报错。 Some tools are conditionally loaded via `feature()` flags or `process.env.USER_TYPE`.
- **`src/constants/tools.ts`** — `CORE_TOOLS` 白名单常量（29 个核心工具名），用于 `isDeferredTool` 白名单制判定。
- **`src/tools/`** — 工具实现目录（含 shared/testing 等辅助目录）。无 barrel，一律深链到具体工具文件。主要分类：
  - **文件操作**: FileEditTool, FileReadTool, FileWriteTool, GlobTool, GrepTool
  - **Shell/执行**: BashTool, PowerShellTool, REPLTool
  - **Agent 系统**: AgentTool, TaskCreateTool, TaskUpdateTool, TaskListTool, TaskGetTool
  - **规划**: EnterPlanModeTool, ExitPlanModeV2Tool, VerifyPlanExecutionTool
  - **Web/MCP**: WebFetchTool, WebSearchTool, MCPTool, McpAuthTool
  - **调度**: CronCreateTool, CronDeleteTool, CronListTool
  - **工具发现**: SearchExtraToolsTool, ExecuteExtraTool, SyntheticOutputTool（wire name 为 `StructuredOutput`）（CORE_TOOLS，用于延迟工具按需加载）
  - **其他**: LSPTool, ConfigTool, SkillTool, EnterWorktreeTool, ExitWorktreeTool 等
- **`src/tools/shared/`** — Tool 共享工具函数。
- **`src/services/searchExtraTools/`** — TF-IDF 工具索引模块（`toolIndex.ts`），为延迟工具提供语义搜索能力。复用 `localSearch.ts` 的 TF-IDF 算法函数（`computeWeightedTf`、`computeIdf`、`cosineSimilarity` 已导出）。修改这些函数时需同步检查工具索引测试。`prefetch.ts` 的 `extractQueryFromMessages` 复用了 `skillSearch/prefetch.ts` 的同名导出函数，修改 skill prefetch 的该函数时需同步检查工具预取行为。工具预取使用独立的 `discoveredToolsThisSession` Set，与 skill prefetch 的去重集合互不影响。

### UI Layer (Ink)

- **`src/ink.ts`** — Ink render wrapper with ThemeProvider injection.
- **`packages/@ant/ink/`** — Custom Ink framework（forked/internal），包含 components、core、hooks、keybindings、theme、utils。注意：不是 `src/ink/`。
- **老控制台兼容模式** — `packages/@ant/ink/src/core/legacyConsole.ts`：检测 Windows build < 17763（无 ConPTY 的老系统，如 1709/LTSC 内网机器）时自动启用；`log-update.ts` 的渲染循环每约 1 秒（`LEGACY_CONSOLE_RESET_MS`）用一次全量重绘替换增量 diff，自愈老 conhost 的光标漂移花屏。`CLAUDE_CODE_LEGACY_CONSOLE=1`/`=0` 可强制开/关。其他环境完全不走此路径。
- **`src/components/`** — 149 个组件目录/文件，渲染于终端 Ink 环境中。关键组件：
  - `App.tsx` — Root provider (AppState, Stats, FpsMetrics)
  - `Messages.tsx` / `MessageRow.tsx` — Conversation message rendering
  - `PromptInput/` — User input handling
  - `permissions/` — Tool permission approval UI
  - `design-system/` — 复用 UI 组件（Dialog, FuzzyPicker, ProgressBar, ThemeProvider 等）
- Components use React Compiler runtime (`react/compiler-runtime`) — decompiled output has `_c()` memoization calls throughout.

### State Management

- **`src/state/AppState.tsx`** — Central app state type and context provider. Contains messages, tools, permissions, MCP connections, etc.
- **`src/state/AppStateStore.ts`** — Default state and store factory.
- **`src/state/store.ts`** — Zustand-style store for AppState (`createStore`).
- **`src/state/selectors.ts`** — State selectors.
- **`src/bootstrap/state.ts`** — Module-level singletons for session-global state (session ID, CWD, project root, token counts, model overrides, client type, permission mode).

### Workspace Packages

| Package | 说明 |
|---------|------|
| `packages/@ant/ink/` | Forked Ink 框架（components、hooks、keybindings、theme） |
| `packages/@ant/computer-use-mcp/` | Computer Use MCP server（截图/键鼠/剪贴板/应用管理） |
| `packages/@ant/computer-use-input/` | 键鼠模拟（dispatcher + darwin/win32/linux backend） |
| `packages/@ant/computer-use-swift/` | 截图 + 应用管理（dispatcher + per-platform backend） |
| `packages/@ant/claude-for-chrome-mcp/` | Chrome 浏览器控制（通过 `--chrome` 启用） |
| `packages/@ant/model-provider/` | Model provider 抽象层 |
| `packages/agent-tools/` | Agent 工具集 |
| `packages/acp-link/` | ACP 代理服务器（WebSocket → ACP agent 桥接） |
| `packages/mcp-client/` | MCP 客户端库 |
| `packages/remote-control-server/` | 自托管 Remote Control Server（Docker 部署，含 Web UI）— Web UI 已重构为 React + Vite + Radix UI，支持 ACP agent 接入 |
| `packages/cloud-artifacts/` | 独立 Cloudflare Worker + R2 服务：POST `/upload` HTML 上传返回 hash URL，GET `/<7d\|30d>/<id>.html` 由 Worker 代理读取；R2 lifecycle rule 自动 7/30 天过期 |
| `packages/audio-capture-napi/` | 原生音频捕获（已恢复） |
| `packages/color-diff-napi/` | 颜色差异计算（完整实现，11 tests） |
| `packages/image-processor-napi/` | 图像处理（已恢复） |
| `packages/modifiers-napi/` | 键盘修饰键检测（macOS FFI 实现） |
| `packages/url-handler-napi/` | URL scheme 处理（环境变量 + CLI 参数读取） |
| `packages/wire-types/` | RCS/ACP 稳定 wire 错误码表（`WireErrorCode` + `wireError` 封套），零依赖，被 acp-link 与 remote-control-server 共享 |
| `packages/workflow-engine/` | 工作流引擎（WORKFLOW_SCRIPTS feature 的执行层） |
| `packages/weixin/` | 微信集成（非 workspace 包） |

辅助目录（无 package.json，非 workspace 包）: `langfuse-dashboard`（Langfuse 面板）、`shared-web-ui`（共享 Web UI 组件）、`highlight-code`（代码高亮）、`claude-pencil`（编辑器）、`vscode-ide-bridge`（VS Code 桥接）、`pokemon`（示例/测试）。

### Bridge / Remote Control

- **`src/bridge/`** — Remote Control / Bridge 模式。feature-gated by `BRIDGE_MODE`。包含 bridge API、会话管理、JWT 认证、消息传输、权限回调等。Entry: `bridgeMain.ts`。
- **`packages/remote-control-server/`** — 自托管 RCS，支持 Docker 部署，含 Web UI 控制面板（React 19 + Vite + Radix UI）。支持 ACP agent 通过 acp-link 接入（ACP WebSocket handler、relay handler、SSE event stream）。通过 `bun run rcs` 启动。
- CLI 快速路径: `claude remote-control` / `claude rc` / `claude bridge`。
- 详见 `docs/features/remote-control-self-hosting.md`。

### HTML Artifact Hosting

- **`packages/cloud-artifacts/`** — 独立 Cloudflare Worker + R2 服务，类似 `remote-control-server/` 的"独立部署服务"定位，**不被主 CLI import**。Worker 处理 `POST /upload`（Bearer token 鉴权 + text/html 校验 + 10MB 上限 + ttl∈{7,30}）和 `GET /<7d|30d>/<id>.html`（从 R2 读 + Cache-Control: max-age=86400）。R2 用 prefix + lifecycle rule 实现 TTL（`7d/` 删 7 天、`30d/` 删 30 天），Worker 不参与过期处理。ID 默认 `nanoid(21)`（126 bit 熵），可指定 `?hash=` 自定义 ID（覆盖目标 TTL key；另一 TTL 的旧 key 由 R2 lifecycle 到期删除，避免并发覆盖跨 prefix 互删）。Worker 用 `wrangler types` 生成的全局 `Env` 类型（`worker-configuration.d.ts`，已 gitignore），不依赖 `@cloudflare/workers-types`。部署用 `npm create cloudflare@latest` 初始化 + `bun run setup`（创建 bucket + lifecycle + secret）+ `bun run deploy`。生产出口经 Deno Deploy 边缘代理（`https://cloud-artifacts.claude-code-best.win`），副作用是 HTTP status code 被抹平为 200（body 的 `{error}` 字段仍保留）。详见 `packages/cloud-artifacts/README.md`。

### ACP Protocol (Agent Client Protocol)

- **`src/services/acp/`** — ACP agent 实现，包含 `agent.ts`（AcpAgent 类）、`bridge.ts`（Claude Code ↔ ACP 桥接）、`permissions.ts`（权限处理）、`entry.ts`（入口）。
- **`packages/acp-link/`** — ACP 代理服务器，将 WebSocket 客户端桥接到 ACP agent。提供 `acp-link` CLI 命令，支持自定义端口/HTTPS/认证/会话管理、RCS 集成（REST 注册 + WS identify 两步流程）、权限模式透传（fallback: 客户端传值 > config > `ACP_PERMISSION_MODE` 环境变量）。
- ACP 权限管道改进：`createAcpCanUseTool` 统一权限流水线，`applySessionMode` 模式同步，`bypassPermissions` 可用性检测（非 root/sandbox 环境）。
- ACP Plan 可视化已支持 `session/update plan` 类型的消息展示（PlanView 组件，含进度条/状态图标/优先级标签）。

### Daemon Mode

- **`src/daemon/`** — Daemon 模式（长驻 supervisor）。feature-gated by `DAEMON`。包含 `main.ts`（entry）和 `workerRegistry.ts`（worker 管理）。

### Context & System Prompt

- **`src/context.ts`** — Builds system/user context for the API call (git status, date, CLAUDE.md contents, memory files).
- **`src/utils/claudemd.ts`** — Discovers and loads CLAUDE.md files from project hierarchy.

### Feature Flag System

Feature flags control which functionality is enabled at runtime. 代码中统一通过 `import { feature } from 'bun:bundle'` 导入，调用 `feature('FLAG_NAME')` 返回 `boolean`。

**启用方式**: 环境变量 `FEATURE_<FLAG_NAME>=1`。例如 `FEATURE_BUDDY=1 bun run dev`。

**Build/Dev 默认 features**（见 `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES`；`build.ts` / `scripts/dev.ts` / compile / vite 共用）:
- 基础: `BUDDY`, `TRANSCRIPT_CLASSIFIER`, `BRIDGE_MODE`, `AGENT_TRIGGERS_REMOTE`, `CHICAGO_MCP`, `VOICE_MODE`
- 统计/缓存: `SHOT_STATS`, `PROMPT_CACHE_BREAK_DETECTION`, `TOKEN_BUDGET`
- P0 本地: `AGENT_TRIGGERS`, `ULTRATHINK`, `BUILTIN_EXPLORE_PLAN_AGENTS`, `LODESTONE`
- P1 API 依赖: `EXTRACT_MEMORIES`, `VERIFICATION_AGENT`, `KAIROS_BRIEF`, `AWAY_SUMMARY`, `ULTRAPLAN`
- P2: `DAEMON`, `ACP`
- 工作流: `WORKFLOW_SCRIPTS`, `HISTORY_SNIP`, `MONITOR_TOOL`, `KAIROS`
- 多 worker: `COORDINATOR_MODE`, `BG_SESSIONS`, `TEMPLATES`
- 连接器: `CONNECTOR_TEXT`, `COMMIT_ATTRIBUTION`, `DIRECT_CONNECT`
- 实验性: `EXPERIMENTAL_SKILL_SEARCH`, `EXPERIMENTAL_SEARCH_EXTRA_TOOLS`
- Agent 增强: `TOOL_LOOP_DETECTION`（工具死循环分级干预）, `SUBAGENT_SUMMARY_GATE`（子代理摘要质量门）, `COMPACT_PRESERVE_USER_MESSAGES`（compact 保留真实用户消息 HEAD+TAIL）, `COMPACT_TAIL_PRESERVATION`（compact 后逐字保留最近 N 个 API round，借鉴 opencode；与 `COMPACT_PRESERVE_USER_MESSAGES` 共用 `postCompactBudget.ts` 的单一天花板：窗口 25% 夹取 2k-16k，tail 优先分配，两者之和不再无条件叠加）, `REACTIVE_COMPACT`（413/media-size 应急压缩；本地单次 compactConversation，非官方全阶梯、非 reactive-only）, `FILE_MUTATION_QUEUE`（同文件 mutation 串行化）, `AGENT_LAUNCH_THROTTLE`（子代理启动限速）
- 模式: `POOR`, `SSH_REMOTE`
- 已禁用: `SKILL_LEARNING`

**Dev mode 默认**: 与 build 相同，启用 `DEFAULT_BUILD_FEATURES`（不是注册表里的全部 flag）；`FEATURE_<NAME>=1` 可追加。裸 `cli.tsx` 全关。

**类型声明**: `src/constants/featureFlags.ts` 是全部 flag 名的注册表（`as const` 数组派生字面量联合类型 `FeatureFlagName`）。`src/types/internal-modules.d.ts` 中 `bun:bundle` 的 `feature(name: FeatureFlagName)` 签名引用该类型，拼错 flag 名会直接 tsc 报错。`DEFAULT_BUILD_FEATURES` 通过 `satisfies readonly FeatureFlagName[]` 校验必须是注册表子集。

**新增功能的正确做法**: 先在 `src/constants/featureFlags.ts` 注册 flag 名，再保留 `import { feature } from 'bun:bundle'` + `feature('FLAG_NAME')` 的标准模式，在运行时通过环境变量或配置控制，不要绕过 feature flag 直接 import。

### Multi-API 兼容层

所有兼容层均采用流适配器模式：将第三方 API 格式转为 Anthropic 内部格式，下游代码完全不改。通过 `/login` 命令配置。

#### OpenAI 兼容层

通过 `CLAUDE_CODE_USE_OPENAI=1` 启用，支持 Ollama/DeepSeek/vLLM 等任意 OpenAI Chat Completions 协议端点。含 DeepSeek thinking mode 支持。

- **`src/services/api/openai/`** — client、消息/工具转换、流适配、模型映射
- 关键环境变量：`CLAUDE_CODE_USE_OPENAI`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`
- **Responses API 路由**：o 系列 / gpt-5*（非 gpt-5-chat）在官方 OpenAI/Azure base 上自动走 `/v1/responses`；`OPENAI_USE_RESPONSES=1/0` 强制开/关；`OPENAI_PROMPT_CACHE_KEY` 可选 prompt cache key。ChatGPT 订阅认证走 Codex Responses 路径。
- **Raw 流日志**：OpenAI 兼容路径默认将原始 provider 事件写入 `~/.claude/debug/<session>.openai.jsonl`（0600 权限，随 debug 日志一起清理），`--no-openai-raw-log` 可禁用。

#### Gemini 兼容层

通过 `CLAUDE_CODE_USE_GEMINI=1` 启用。独立环境变量体系。

- **`src/services/api/gemini/`** — client、模型映射、类型定义
- 关键环境变量：`GEMINI_API_KEY`（必填）、`GEMINI_MODEL`（直接指定）、`GEMINI_DEFAULT_SONNET_MODEL`/`GEMINI_DEFAULT_OPUS_MODEL`（按能力映射）
- 模型映射优先级：`GEMINI_MODEL` > `GEMINI_DEFAULT_*_MODEL` > `ANTHROPIC_DEFAULT_*_MODEL`(已废弃) > 原样返回

#### Grok 兼容层

通过 `CLAUDE_CODE_USE_GROK=1` 启用。自定义模型映射支持 xAI Grok API。

- **`src/services/api/grok/`** — client、模型映射

详见各兼容层的 docs 文档。

### 穷鬼模式（Budget Mode）

- 通过 `/poor` 命令切换，持久化到 `settings.json`。
- 启用后跳过 `extract_memories`、`prompt_suggestion` 和 `verification_agent`，显著减少 token 消耗。
- 实现在 `src/commands/poor/poorMode.ts`。

### Stubbed/Deleted Modules

| Module | Status |
|--------|--------|
| Computer Use (`@ant/*`) | Restored — macOS + Windows + Linux（后端完整度不一） |
| `*-napi` packages | 全部已恢复/实现：`audio-capture-napi`、`image-processor-napi` 已恢复；`color-diff-napi` 完整；`modifiers-napi`（macOS FFI）；`url-handler-napi`（环境变量+CLI） |
| Voice Mode | Restored — Push-to-Talk 语音输入（需 Anthropic OAuth） |
| OpenAI/Gemini/Grok 兼容层 | Restored |
| Remote Control Server | Restored — 自托管 RCS + Web UI |
| `packages/shell/`, `packages/swarm/`, `packages/mcp-server/`, `packages/cc-knowledge/` | Removed — 功能合并或废弃 |
| Analytics / GrowthBook / Sentry / BigQuery | Disabled — 1P analytics（tengu_*）硬关闭：`is1PEventLoggingEnabled()` 恒 false，从不发送 `api/event_logging/batch`、不写 `~/.claude/telemetry/`；GrowthBook 远端拉取禁用，`isGrowthBookEnabled()` 恒 false，feature gates 走 `LOCAL_GATE_DEFAULTS` 本地解析（`CLAUDE_CODE_DISABLE_LOCAL_GATES=1` 可绕过）；BigQuery metrics：`isBigQueryMetricsEnabled()` 恒 false（不 POST `/api/claude_code/metrics`，与客户 OTEL 解耦）；Sentry 无 DSN 时为 inert |
| Magic Docs / LSP Server | Restored — Magic Docs 自动更新 + LSP 服务器管理器 |
| Plugins / Marketplace | Restored — 插件安装/卸载/启用/禁用 + Marketplace 浏览 |
| MCP OAuth | Simplified |

### Key Type Files

- **`src/types/global.d.ts`** — Declares `MACRO`, `BUILD_TARGET`, `BUILD_ENV` and internal Anthropic-only identifiers.
- **`src/types/internal-modules.d.ts`** — Type declarations for `bun:bundle`, `bun:ffi`, `@anthropic-ai/mcpb`.
- **`src/types/message.ts`** — Message type hierarchy (UserMessage, AssistantMessage, SystemMessage, etc.).
- **`src/types/permissions.ts`** — Permission mode and result types.

## Testing

- **框架**: `bun:test`（内置断言 + mock）
- **单元测试**: 就近放置于 `src/**/__tests__/`，文件名 `<module>.test.ts`
- **集成测试**: `tests/integration/` — 7 个文件（cli-arguments, context-build, message-pipeline, tool-chain, autonomy-lifecycle-user-flow, dependency-overrides, goal-lifecycle）
- **共享 mock/fixture**: `tests/mocks/`（api-responses, file-system, fixtures/）
- **命名**: `describe("functionName")` + `test("behavior description")`，英文
- **包测试**: `packages/` 下各包也有独立测试（如 `color-diff-napi` 11 tests）

### Faux provider（脚本化离线 LLM）

`CLAUDE_CODE_USE_FAUX=1` + `CLAUDE_CODE_FAUX_SCRIPT=<path>` 让整条 CLI 走 `src/services/api/faux/`，回放脚本里预设的回答，不联网、不读凭据、`total_cost_usd` 恒为 0。用于 e2e 测试和 evals。

```jsonc
{ "turns": [
    { "text": "Reading it.",
      "toolUses": [{ "name": "Read", "input": { "file_path": "/tmp/a" } }] },
    { "text": "Done." }
] }
```

轮次由 transcript 里的 assistant 消息数推导（不是模块级计数器），所以 resume/fork/并行 subagent 都能复现同一结果。`CLAUDE_CODE_FAUX_DELAY_MS` 可给每个事件加延迟，用于观察增量渲染。

**faux 故意不加入 `APIProvider` 联合类型** —— 该联合喂给 `ModelConfig = Record<APIProvider, ModelName>`，加入会连带改 12 处 config 字面量和约 60 处无穷尽性检查的行为分支（betas/thinking/effort/cost/auth/`/status`），而 faux 不需要其中任何一处。它在 `queryModel` 的 dispatch 处按环境变量短路，位置在所有 provider 分支之前。

**faux 与 VCR 互斥，且 faux 优先** —— 两者都是"替换真实 API"的同类接缝，但 `withVCR`/`withStreamingVCR` 包在 `queryModel` **外面**，所以 VCR 会在 faux 短路之前就要求命中 fixture。`shouldUseVCR()` 因此在最前面检查 faux 并返回 `false`。缺这个 guard 时，任何 `NODE_ENV=test` 下的 faux 运行（`bun test` 会设置它，子进程继承）都会死在 "fixture missing" 上 —— 报错信息完全不提 faux，极难定位。

**`isFauxProviderEnabled()` 放在 `src/utils/envUtils.ts`，不在 faux 模块里** —— 四个调用方（`auth.ts` 凭据查找、`vcr.ts` gate、`claude.ts` dispatch、`sideQuery.ts` 兜底 throw）都在启动早期或热路径上，不应为读一个环境变量而把 Anthropic SDK 拖进 import 图。该函数刻意用 `=== '1'` 精确匹配而非 `isEnvTruthy`：这个开关会屏蔽真实 API 调用和凭据读取，必须无法被误开（继承来的 `CLAUDE_CODE_USE_FAUX=true` 不能算）。

### Evals harness

`src/evals/runner.ts` 用 faux provider 跑完整 CLI 子进程做离线 e2e 断言：

```ts
const result = await runEvalAndClean({
  prompt: 'Say hello',
  fauxScript: [{ text: 'Hello from faux!' }],
})
expect(result.output).toContain('Hello from faux!')
```

`fauxScript` 支持函数形式 `(dir) => turns` 以引用 `setup(dir)` 创建的 fixture 路径。脚本里的 tool call 会**真实执行**，但 CLI 的权限模型仅允许 cwd（项目根目录）内的文件操作 —— `dir` 是 `/tmp` 下的临时目录，在根目录之外，工具调用会被静默拒绝（exit 0，无错误输出）。需要断言文件系统副作用时，fixture 必须放在项目根目录内，用绝对路径在 faux script 里引用。用 `runEval` + `cleanupEval(result)` 保留 `dir` 做事后文本/文件断言；纯文本输出断言用 `runEvalAndClean`。

子进程跑的是 `bun src/entrypoints/cli.tsx`（不是 `dist/cli.js`），cwd 固定为项目根目录 —— `src/*` 路径别名从 cwd 最近的 `tsconfig.json` 解析，cwd 换成临时目录会解析失败。用源码入口也意味着不需要预先 build，且永远测的是当前代码。fixture 文件放在 `dir`（绝对路径引用），不受 cwd 影响，但如上所述，工具操作 `dir` 内文件会被权限系统拦截。

### Transcript 格式兼容路径

Transcript 文件是 append-only JSONL，加新字段不破坏旧读取，但有三条已编码的历史兼容路径，修改 load 路径时需避免破坏它们：

1. **pre-PR #24099 `progressBridge`**（`isLegacyProgressEntry` / `progressBridge` Map）— 旧格式的 progress 条目在 transcript 中留有 `type:'progress'` 行。加载时在 parse 循环内用 `progressBridge` Map 跨行累积，最终重写后续条目的 `parentUuid`。这是跨条目的有状态变换，不是 per-entry 转换。

2. **pre-PR #23537 progress-fork**（`recoverOrphanedParallelToolResults`）— 并行工具调用的 progress fork 留下孤儿分支，通过 `recoverOrphanedParallelToolResults` 在 chain 构建阶段修复，不在 parse 阶段。

3. **pre-last-prompt `extractFirstPromptFromChunk` 回退**（load path line ~4900）— 早于 last-prompt 条目存在之前写入的 session 没有 last-prompt 元数据行，用 `extractFirstPromptFromChunk` 从内容中提取。

**不要新增 `schemaVersion` 字段**：`version`（CLI semver）已经戳在每条 transcript entry 上（`sessionStorage.ts:1084`），`src/utils/semver.ts` 已提供 `lt`/`order`，但 load 路径没有任何代码读取它。上述三条兼容路径都是 shape-detect（检查字段是否存在/类型），而非 version-key。新的格式变更也应遵循 shape-detect 模式，不要引入第二套版本号概念。

**`{"parentUuid":` 是 byte-level line 前缀不变式**：`walkChainBeforeParse`（`sessionStorage.ts:3399`）在 JSON parse 之前用该前缀区分 transcript 消息行与元数据行，对 >5 MB session 实测节省 80-93% parse 时间。该不变式依赖 `JSON.stringify` 按插入顺序序列化 key，以及 `insertMessageChain` 的 `transcriptMessage` 对象字面量以 `parentUuid` 为第一个 key。在 `insertMessageChain` 字面量中，**不得在 `parentUuid` 之前插入任何字段**——这不会产生编译错误，但会在大 session 上静默退化为全量解析。此不变式已在 `src/utils/__tests__/sessionStorage.test.ts` 的 `walkChainBeforeParse parentUuid-first-key invariant` 测试组中锁定。

### Mock 使用规范

**只 mock 有副作用的依赖链，不 mock 纯函数/纯数据模块。**

被迫 mock 的根源：`log.ts` / `debug.ts` → `bootstrap/state.ts`（模块级 `realpathSync` / `randomUUID` 副作用）。必须 mock 的模块：`log.ts`、`debug.ts`、`bun:bundle`、`settings/settings.js`、`config.ts`、`auth.ts`、第三方网络库。

**`log.ts` 和 `debug.ts` 使用共享 mock**（`tests/mocks/log.ts` / `tests/mocks/debug.ts`），不要在测试文件中内联 mock 定义。使用方式：

```ts
import { logMock } from "../../../tests/mocks/log";
mock.module("src/utils/log.ts", logMock);

import { debugMock } from "../../../../tests/mocks/debug";
mock.module("src/utils/debug.ts", debugMock);
```

源文件导出变更时只需更新 `tests/mocks/` 下的对应文件，不需要逐个修改测试。

不要 mock：纯函数模块（`errors.ts`、`stringUtils.js`）、mock 值与真实实现相同的模块、mock 路径与实际 import 不匹配的模块。

路径规则：统一用 `.ts` 扩展名 + `src/*` 别名路径，禁止双重 mock 同一模块。

#### 跨文件 mock 污染（process-global `mock.module`）

**Bun 的 `mock.module` 是进程全局的（last-write-wins），不是 per-file 隔离的。** 一个测试文件的 `mock.module` 会污染同一进程中所有其他测试文件的 `require`/`import`。

**关键事实（Bun 1.x 实测验证）：**
- 测试文件执行顺序**不是严格字母序**，不要假设文件 A 一定在文件 B 之前执行。
- `mock.module` 在 `beforeAll` 内部调用时**不会被提升**（hoist），但仍会污染后续加载的文件。
- `require()` 和 `import()` 共享同一模块注册表，`mock.module` 对两者都生效。
- 一个模块一旦被某个文件的 `mock.module` 替换，同一进程中所有后续 `require`/`import` 都会返回 mock 值，即使调用方使用不同的 specifier 路径。

**核心规则：不要 mock 被测模块的上层业务模块。**

错误做法（会污染同目录的 `api.test.ts`）：
```ts
// launchSchedule.test.ts — 直接 mock 源 API 模块 ❌
mock.module('src/commands/schedule/triggersApi.js', () => ({
  listTriggers: listTriggersMock,
  // ...
}))
```

正确做法（mock 底层 HTTP 层，不污染业务模块）：参考 `launchSkillStore.test.ts`、`launchVault.test.ts` 的模式。
```ts
// launchSchedule.test.ts — mock axios 而非 triggersApi ✅
import { setupAxiosMock } from '../../../../tests/mocks/axios.js'

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.get = axiosGetMock
axiosHandle.stubs.post = axiosPostMock

beforeAll(() => { axiosHandle.useStubs = true })
afterAll(() => { axiosHandle.useStubs = false })
```

**判断标准：** 如果目录下同时有 `launch*.test.ts`（集成测试）和 `api.test.ts`（回归测试），`launch*.test.ts` 必须 mock axios 而非源 API 模块。`api.test.ts` 需要测试真实 API 模块的 HTTP 方法/URL/错误处理逻辑，被 mock 后就无法测试。

**排查 mock 污染的方法：**
1. 单独运行可疑文件确认其通过：`bun test path/to/suspect.test.ts`
2. 与同目录其他文件一起运行定位污染源：`bun test path/to/__tests__/`
3. 在两个文件中各加 `console.error('[file] milestone')` 追踪实际执行顺序
4. 检查 `mock.module` 的 specifier 是否与同目录其他测试的 `require`/`import` 路径解析到同一模块

### 类型检查

项目使用 TypeScript strict 模式，**tsc 必须零错误**。每次修改后运行：

```bash
bun run precheck
```

**类型规范**：
- 生产代码禁止 `as any`；测试文件中 mock 数据可用 `as any`
- 类型不匹配优先用 `as unknown as SpecificType` 双重断言，或补充 interface
- 未知结构对象用 `Record<string, unknown>` 替代 `any`
- 联合类型用类型守卫（type guard）收窄，不要强转
- `msg.request` 属性访问：`const req = msg.request as Record<string, unknown>`
- Ink `color` prop：用 `as keyof Theme` 而非 `as any`

## Working with This Codebase

- **precheck must pass** — `bun run precheck`（typecheck + lint fix + test）必须零错误，任何修改都不能引入新的类型/lint/测试错误。
- **Feature flags** — 默认全部关闭（`feature()` 返回 `false`）。Dev/build/compile 共用 `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES`，不是「全部启用」。不要在 `cli.tsx` 中重定义 `feature` 函数。
- **React Compiler output** — Components have decompiled memoization boilerplate (`const $ = _c(N)`). This is normal.
- **`bun:bundle` import** — `import { feature } from 'bun:bundle'` 是 Bun 内置模块，由运行时/构建器解析。不要用自定义函数替代它。**`feature()` 只能直接用在 `if` 语句或三元表达式的条件位置**（Bun 编译器限制），不能赋值给变量、不能放在箭头函数体里、不能作为 `&&` 链的一部分。正确：`if (feature('X')) {}` 或 `feature('X') ? a : b`。
- **`src/` path alias** — tsconfig maps `src/*` to `./src/*`. Imports like `import { ... } from 'src/utils/...'` are valid.
- **MACRO defines** — 集中管理在 `scripts/defines.ts`。Dev mode 通过 `bun -d` 注入，build 通过 `Bun.build({ define })` 注入。修改版本号等常量只改这个文件。
- **构建产物兼容 Node.js** — `build.ts` 会自动后处理 `import.meta.require`，产物可直接用 `node dist/cli.js` 运行。
- **Biome 配置** — 42 条 lint 规则因 decompiled 代码被关闭，仅保留 `recommended` 基线。格式化覆盖全项目（`src/`、`scripts/`、`packages/`，含 `packages/@ant/`）。`.tsx` 文件用 120 行宽 + 强制分号；其他文件 80 行宽 + 按需分号。JSON 格式化已启用。`.editorconfig` 与 Biome 配置对齐（2-space 缩进）。修改任何代码后应运行 `bun run precheck` 确认无类型/lint/格式/测试问题，pre-commit hook 会自动拦截不合格提交。
- **tsc 与 Biome 冲突处理** — 当 tsc 要求声明属性（赋值使用）但 biome 报 `noUnusedPrivateClassMembers`（只写不读）时，用 `// biome-ignore lint/correctness/noUnusedPrivateClassMembers: <原因>` 抑制 lint 警告，保留类型声明。`biome ci` 必须零 warnings。
- **`eslint-disable` 注释是历史遗留，不是生效的抑制** — 本仓库没有 ESLint（无依赖、无配置文件），`custom-rules/*` 的规则实现也已不在仓库里。所以任何 `eslint-disable` 都**不会**被任何工具读取。无理由的裸压制已清理；保留下来的都带 `--` 理由（例如 `no-sync-fs -- must be sync to flush before process.exit`），它们的价值只在于**记录当初的设计意图**，读代码时应当这样理解，不要以为存在对应的守卫。需要真正的强制时用 Biome 规则或 `scripts/` 下的检查（参考 `check-boundaries.ts`）。
- **依赖边界棘轮** — `packages/` 内禁止新增 `from 'src/...'` 反向导入主应用。棘轮**按包**计数（基线见 `scripts/boundaries-baseline.json` 的 `perPackage`，每个包各自只减不增；基线中没有的包上限为 0，新包一旦越界立刻失败）。存量已降到 3 条（`builtin-tools` 曾占 1205 条，该包已并回 `src/tools/`）。按包计数的意义在于：总数棘轮下，一个大包的清理能为别的包新增的越界导入买单，总数不变而方向性退化已经发生。共享逻辑应下沉到 workspace 包或通过参数/注入传入；跨 `packages/` ↔ `src/` 的小工具确实无法共享时，两侧各留一份并在注释里互指（如 `strip1mContextSuffix`）。解耦后运行 `bun scripts/check-boundaries.ts --update` 收紧基线并提交。
- **`@ts-expect-error` 维护** — 只在下方代码确实有类型错误时保留 `@ts-expect-error`。如果类型系统已更新导致 directive 变为 unused（TS2578），直接移除注释。MACRO 替换产生的永假比较（如 `'production' === 'development'`）仍需保留 `@ts-expect-error`。
- **Ink 框架在 `packages/@ant/ink/`** — 不是 `src/ink/`（该目录不存在）。Ink 相关的组件、hooks、keybindings 都在 packages 中。
- **模型事实只写一处** — `src/utils/model/configs.ts` 的 `MODEL_CATALOG` 是模型事实的唯一来源，字段名镜像官方模型表的对象键（`display_name` / `knowledge_cutoff` / `provider_ids` / `context.{window,native_1m,supports_1m_beta,supports_1m_suffix}` / `max_output_tokens.{default,upper}` / `pricing` / `capabilities` / `default_effort`）。provider 各家 ID、窗口解析、输出上限、定价、effort 门控与默认值、知识截止、system prompt 里的最新机型全部从它派生，新增模型只改这一张表。改完跑 `bun run check:drift`，它会把这张表与官方 bundle 逐字段对账。
- **Provider 优先级** — `modelType` 参数 > 环境变量 > 默认 `firstParty`。新增 provider 需在 `src/utils/model/providers.ts` 注册。
- **`query()` 不得抛出** — `src/query.ts` 的 `query()` 是 StreamFn 合约：所有失败**必须** yield 为 stream 事件，不能 throw。任何逃逸出该 generator 的异常会静默截断流，不产生错误消息。新增错误路径时必须 `yield` 而非 `throw`。
- **文档保留标准** — 描述"当前是什么"的文档保留（架构说明、feature 文档、设计指南）；描述"过去做了什么"的文档删除（审计报告、带日期的修复计划、任务清单、调研记录、测试报告）。**规则是资产，过程是垃圾** —— 过程属于 git history，不属于工作区。判定标准不是"是否被链接"：`docs/features/ssh-remote.md` 无人链接但记录着活跃 feature flag，属于保留项；而互相引用成闭环的"审计 + 修复计划"两件套，链接再多也是过程。写完一轮的执行计划后，按同一标准删掉它自己。
- **ignore 规则必须锚定** — 新增 ignore 规则时，只想匹配仓库根的目录必须写 `/name/` 而非裸 `name`。裸规则匹配任意深度，会静默吞掉未来的同名源码目录（如 `data` 吞掉 `tests/data/`、`logs` 吞掉 `src/utils/logs/`），且**不产生任何警告**。需要在被忽略目录内开洞时，必须用 glob 形式 `dir/*` 而非 `dir/` —— 带尾斜杠的目录排除会让 git 拒绝下降，里面所有 `!` 否定项全是死规则。改完用 `git ls-files -i -c --exclude-standard`（应为 0 行）验证没有 tracked-but-ignored 矛盾。

## Design Context

Impeccable 设计上下文保存在 `.impeccable.md` 中。设计 Web UI（RCS 控制面板、文档站、着陆页）时必须参考该文件。

### 核心设计原则

1. **Considered over clever** — 每个设计选择都应感觉有意为之，而非追逐潮流
2. **Warmth through subtlety** — 通过橙色色调的中性色、留白布局、有温度的文案来传达温暖
3. **Density with clarity** — 技术用户需要信息密度，但不能混乱
4. **Community voice** — 设计应感觉是由使用者创造的，而非遥远的设计团队
5. **Anthropic's shadow** — 遵循 Anthropic 的设计直觉：干净的布局、充足的间距、温暖的色温

### 品牌色

- 主色：Claude Orange `#D77757`（terra cotta）
- 辅色：Claude Blue `#5769F7`
- 暗色模式使用温暖的深色表面（非冷蓝黑色）

### 目标用户

技术团队/企业，在专业工作流中使用 AI 辅助编程。友好的开源社区氛围，非企业 SaaS 风格。

### 视觉参考

Anthropic 公司的设计风格 — 干净、考究、温暖的底色。大量留白，以排版为核心。避免 AI 产品常见的设计套路（渐变文字、玻璃态、霓虹色）。
