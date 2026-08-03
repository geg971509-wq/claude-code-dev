# 仓库清洁化：达到发行版标准

## Context

当前分支 `fix/stream-lifecycle-hardening` 与 `origin` 同步（0 ahead / 0 behind），工作区干净。但仓库存在四类真实缺陷，使其达不到"发行版"标准：

1. **npm 发布链路已断** —— `package.json` 的 `dependencies` 含 `"@claude-code-best/core-utils": "workspace:*"`，指向一个 `private: true` 的本地包。下一次打 tag 发版会把这个非法版本号原样写进 registry manifest，用户 `npm install` 直接失败。这是"发行版"字面意义上的阻塞点。
2. **`.gitignore` 规则会静默隐藏真实源码** —— 不是美观问题，是会丢代码的 bug。
3. **61 个过程产物被 track** —— 审计报告、带日期的计划、任务清单、JIRA 草稿、死配置。这些属于 git history，不属于工作区。
4. **4 条 dead pointer（5 个修改点）+ 4 个 ignore/配置文件有失效规则** —— 文档指向已删除文件、README 顶部一个坏 LICENSE badge，以及转义失效（`\*` 匹配字面星号）导致构建产物不被忽略。

目标：只做删除与修正，不新增脚手架（不加 LICENSE / CODEOWNERS / dependabot / PR 模板 —— 用户明确要求"不必要的文件就不要了"）。全部为 forward-only 提交，**不重写历史**（分支已推送，force-push 属破坏性操作）。

## 审计共识（4 agent 发起 / 3 份终稿达成销审条件）

按 `/Users/king/Desktop/AGENTS.md` 第 3–5 步执行：4 个独立 agent 按 12 个维度审计本计划，3 份终稿返回即结束审计（#1 critic、#2 architect、#3 verifier；#4 未完成，不阻塞）。本节只记录**改变了执行方式**的部分，其余修正已就地并入下文各阶段。

**#3 verifier 判定 FAIL / REQUEST_CHANGES**，但附结论"补齐 6 条后可一次性无暂停执行完"，并在克隆仓库跑完 4 阶段 dry run：`67 files changed, 32 insertions(+), 24258 deletions(-)`，tracked-but-ignored 归零，nav 62 条 0 missing，typecheck exit 0，boundaries `1209 reverse imports == baseline`。

三个结构性问题（均已实测复现，不是纸面意见）：

1. **原阶段 1d 的做法根本不生效。** `.gitignore:16` 是带尾斜杠的 `.claude/`，git 因此**拒绝下降进该目录**，里面所有 `!` 否定项全是死规则。A/B 实测：加 `!.claude/agents/hello-agent.md` 后该文件仍被忽略，命中行仍报 `.gitignore:16:.claude/`。原计划"仿照现有 `.codex` 否定块模式"恰好不可照搬 —— `.codex` 能工作正是因为写成 glob 形式 `.codex/*`（`.vscode/*` 同理）。必须改写为 `.claude/*` + 逐层开洞。
2. **改写为 `.claude/*` 后仍只解放 2 of 4 个文件。** `skills/teach-me/SKILL.md` 与 `references/pedagogy.md` 被 `:47` 那条无锚定的 `teach-me` 以 last-match-wins 二次拦下。所以 1b 的锚定（`teach-me` → `/teach-me/`）是 1d 的**硬前置**，而原计划把这 2 个文件的成因归给 `:16`，归因错了。
3. **1b/1d/1e 不能按行号分三步执行。** 1d 插入 7 行后 1e 的所有行号漂移，照字面执行会删掉刚加的否定项和本该保留的 `.omx/` 规则。三者必须合并为**一次按内容匹配的整体改写**。

12 处事实性修正（#1 critic，已逐条复核）：README 线上 URL 19→**16** 且 `ssh-remote` 不在其中；删除文件数 55→**58**；体积 1.2MB→**1.05MB**；`.omc` 嵌套位置 8→**10**；`ps-shell-selection` 死引用 4→**5**；`claude-api` 缺失 import 27→**26**；`computer-use.md` 少的入链 2→**1**；`verify/` 的 import 方在 `src/skills/bundled/verifyContent.ts`；computer-use v2 重构**大部分已执行**（只有 §5 的删除项没做，口径改为"提案已被实现取代"）；`docs/task/` 8 个文件里只有 **3 个**标了 `状态: DONE`（`task-016` 无状态行），不能说"均标注 DONE"；`mint.json` 不是 `docs.json` 的内容子集（70 条 nav，10 页独有）；DEV-LOG"引用 14 个文档"无有效计数依据（"其中 2 个已死"准确）。

## 已验证的关键约束（决定了哪些文件不能删）

这些是本次调查中推翻我最初假设的发现，实施时必须遵守：

- **README 用线上 URL 引用 16 个 docs**（`ccb.agent-aura.top/docs/...`，已逐条数清；原计划写 19 是错的）。这些文件 grep 看起来是孤儿，实际是承重的。包括 `uds-inbox`、`channels`、`acp-zed`、`all-features-guide`、`chrome-use-mcp` 等。**不可删。** 注意 `ssh-remote` **不在**这 16 个里 —— 它的保留理由是另一条（记录着活跃 feature flag），不要把它当 README 承重项。16 个中有 9 个不在 `docs.json` nav 内。
- **`Friends.md` 被 `README.md:17` 引用** —— 保留。
- **`contributors.svg` 被 `README.md:226` 引用，且由 `update-contributors.yml` 自动重新生成** —— 删了会破坏 README 且 CI 会写回。保留。
- **`docs.json` 是唯一生效的 Mintlify 配置**（62 条 nav，零 dead entry）；`mint.json` 是被取代的 v1 配置，无人读取 —— 可删。但删除理由**不是**"内容是 docs.json 的子集"（那是错的：`mint.json` 有 70 条 nav，其中 10 页 docs.json 里没有，6 页还被 README URL 引用）。真正的理由是**nav 成员资格不决定是否可访问** —— 已实测 5 个不在 docs.json nav 里的页面全部返回 HTTP 200。所以那 10 页在删掉 `mint.json` 后仍然可访问，README 的 9 个非 nav URL 也不会断。
- **`src/skills/bundled/verify/` 是构建期 import**（import 方是 `src/skills/bundled/verifyContent.ts`，原计划路径写漏了一层），无 prose 引用。任何基于 grep 的孤儿清理都会误删它 —— **不可碰**。
- **`git clean` 从不删除已 track 文件** —— 我最初说 `*.lock` 会让 `clean -X` 删掉 `bun.lock`，这是错的。真正的 `clean -X` 风险是根目录 `config/`。
- **`.superpowers/` 不污染 `git status`** —— 它内含 `sdd/.gitignore` 为 `*`，自我忽略。`git status -uall` 输出 0 行。
- **根 `.dockerignore` 是活的** —— `packages/remote-control-server/Dockerfile` 用根构建上下文，其 `docs` 排除项挡掉了 42MB 图片。

## 阶段 0：修复 npm 发布阻塞（P0，最高优先）

用户要"发行版的 git"。这个仓库的发行出口是 `.github/workflows/publish-npm.yml`（由 `v*` tag 触发），而该出口当前是坏的。以下三项均为本轮新查出、原计划完全未覆盖。

### 0a. `dependencies` 里的 `workspace:*` 会让 `npm install` 失败（硬阻塞）

`package.json:73` 有 `"@claude-code-best/core-utils": "workspace:*"`。npm **不重写** `workspace:` 协议（那是 pnpm/yarn/bun 的特性），它会原样进入发布的 manifest。

已实测证据：

```
# 真实 npm pack 后，tarball 内 package/package.json 的 dependencies：
  @claude-code-best/core-utils: workspace:*   <<< registry 无法解析
# 该包本身：
  packages/core-utils/package.json → private: true
# registry 查询：
  npm error 404 Not Found - GET .../@claude-code-best%2fcore-utils
```

时序证明这是**潜伏回归**，不是历史遗留：

| commit | 日期 | 事件 |
|---|---|---|
| `34b3dc99` | 2026-07-21 | `chore: v2.8.4` —— 已发布，registry 上的 2.8.4 依赖表**不含** core-utils（实测确认） |
| `3647b30c` | 2026-07-26 | `refactor: 抽出 core-utils workspace 包以收紧依赖边界` —— 引入该非法依赖 |

即 v2.8.4 侥幸发在引入之前；**下一次打 tag 必炸。**

**修法**：移到 `devDependencies`，与其余 15 个 workspace 包保持一致。

已验证零运行时影响 —— `vite.config.ts:72` 是 `noExternal: true`，`external` 白名单仅 `['doubaoime-asr','opus-encdec']`，core-utils 被完全 inline：

```
grep -rl "@claude-code-best/core-utils" --include='*.js' dist/   → 0 个文件
grep -rl "doubaoime-asr"                --include='*.js' dist/   → 2 个文件（external 对照组，保留裸 import）
```

`.map` 里有命中，但 sourcemap 存的是原始路径，不是运行时 import —— 不能作为判据。

### 0b. `files: ["dist"]` 是整目录纳入，会把本地构建残留发出去（中危）

`dist/` 是 gitignored 的，所以 tarball 内容完全取决于**发布时本地 `dist/` 的状态**。实测本地 `npm pack`：

```
压缩后 92MB / 解包 309MB / 1296 个文件
  dist/ccb        89.0 MB   ← build.sh 产物（mac 独立可执行）
  dist/ccb.exe   122.3 MB   ← build.sh 产物（win 独立可执行）
  640 个 .map     59.9 MB   ← build.ts 的 sourcemap:'linked' 产物
```

CI 路径本身是干净的（全新 checkout → `prepublishOnly` 跑 `build:vite`，而 `vite.config.ts:85` 为 `sourcemap: false`，且 `build.sh` 不在 CI 中执行）。所以这不是 CI 阻塞，**但任何人本地 `npm publish` 都会发出 200MB+ 垃圾**，且 `files` 白名单无法阻止。

**修法**：把 `dist` 收窄为显式子项（`dist/*.js`、`dist/chunks/`、`dist/vendor/`），或在 `files` 中排除 `dist/ccb*` 与 `*.map`。取前者，白名单比黑名单可靠。

### 0c. `postinstall.cjs` 的 `undici` 裸 require 无兜底（低危）

`scripts/postinstall.cjs:154` 在 `proxyEnvSet()` 为真时 `require('undici')`，而 `undici` 只在 `devDependencies` —— npm 安装用户没有它。同文件 `:216` 的 `require('fflate')` 有 `try/catch` 兜底（`:215`），`undici` 这处没有。

影响面：仅"设了代理环境变量的 npm 用户"，且失败发生在 postinstall 的 ripgrep 下载环节。**修法**：套 `try/catch`，失败时回退到全局 `fetch`（`:161` 已有该分支）。

## 阶段 1：修正会丢代码的 `.gitignore` 缺陷（P0）

### 1.0 执行前必做的两个备份（审计新增，不可跳过）

本阶段有两处**不能用 git 回滚**的改动，必须先手工备份：

```bash
cp .git/info/exclude /tmp/git-info-exclude.bak      # 该文件不受版本控制
tar czf /tmp/teach-me.bak.tgz teach-me/             # git rm --cached 后它只存在于磁盘
```

`.git/info/exclude` 是 per-clone 的、从不随仓库分发、也不在版本控制里 —— 改错了 `git checkout` 救不回来。`teach-me/` 在 `git rm --cached` 之后就成了纯未 track 文件，此时它同时暴露在 `git clean -Xd` 的射程内（`/teach-me/` 规则命中 + 未 track = 会被清掉）。备份是唯一保险。

### 1a. 锚定 `.git/info/exclude` 的裸 `config/` 规则

`.git/info/exclude:8` 的 `config/` 无锚定，匹配任意深度。已验证后果：

```
src/commands/config/config.tsx        被忽略（已 track，故当前无感）
src/commands/config/BRAND_NEW.ts      被忽略  ← 新增源码静默消失
packages/mcp-client/src/config/*.ts   被忽略  ← 未来的包内 config 目录
```

任何人往 `src/commands/config/` 加文件，`git status` 不显示、无警告。且 `.git/info/exclude` 是 per-clone、不随仓库分发的，所以每个贡献者的行为都不同 —— 这是最强的删除理由。

同时 `git clean -Xdn` 报告 `Would remove config/`，而根 `config/mcporter.json`（本地 mcporter 状态，mode 600）确实应被忽略 —— 因此改为锚定的 `/config/` 而非直接删除整行。

**改动**：`.git/info/exclude` 第 8 行 `config/` → `/config/`。

### 1b. 根 `.gitignore`：一次按内容匹配的整体改写（合并原 1b + 1d + 1e）

**为什么必须合并成一步**（审计共识第 3 条）：原计划把锚定、加否定项、删死规则拆成三个按行号描述的子步骤。但加否定项会插入 7 行，此后 1e 引用的所有行号全部漂移 —— 照字面执行会删掉刚加的否定项，并误删本该保留的 `.omx/` 规则。所以本阶段一次性完成，**所有编辑按内容匹配定位，不按行号**。

三条无锚定规则的潜伏后果（当前这些路径都不存在，故为潜伏而非活跃）：

| 规则 | 会静默吞掉 |
|---|---|
| `data` | `tests/data/fixture.json`、`packages/core-utils/src/data/schema.ts` |
| `logs` | `src/utils/logs/logger.ts` |
| `teach-me` | `src/skills/teach-me/index.ts` |

`tests/data/` 是极其普通的新增目录。三条改为 `/data/`、`/logs/`、`/teach-me/`。

**其中 `teach-me` → `/teach-me/` 是解放 `.claude/` 的硬前置**：不锚定它，`.claude/skills/teach-me/SKILL.md` 与 `.claude/skills/teach-me/references/pedagogy.md` 会被这条无锚定规则以 last-match-wins 二次拦下，即使 `.claude/` 已改成 glob 形式也没用。

**`.claude/` 必须从目录形式改成 glob 形式。** 这是本阶段最关键的一处，也是原计划唯一实测证伪的做法：

```
# 现状（.gitignore:16 为 `.claude/`，带尾斜杠）
# A/B 实测：追加 !.claude/agents/hello-agent.md 之后
$ git check-ignore -v .claude/agents/hello-agent.md
.gitignore:16:.claude/        .claude/agents/hello-agent.md     ← 否定项完全无效
```

git 遇到尾斜杠的目录排除会**拒绝下降进该目录**，因此里面所有 `!` 否定项都是死规则。`.vscode/*` 和 `.codex/*` 之所以能开洞，正是因为它们写成 glob 形式。改写后（`.claude/*` + 逐层开洞）：

```gitignore
.claude/*
!.claude/agents/
.claude/agents/*
!.claude/agents/hello-agent.md
!.claude/skills/
.claude/skills/*
!.claude/skills/teach-me/
.claude/skills/.drafts/
```

逐层开洞是必需的：git 只有在父目录未被排除时才会检查子路径，所以每一层都要先 `!` 放行目录、再 `*` 排除该层其余内容。

`.claude/skills/.drafts/` 这条是新增的（审计发现）：`.claude/skills/.drafts/draft-refactor-api-gateway/` 当前是未 track 且被 `.claude/` 整体挡住的草稿目录，一旦改成 glob 形式它会**新出现在 `git status` 里**。必须同时补这条排除，否则本次清理反而制造出新的脏工作区。

**四条否定项解决 tracked-but-ignored 矛盾。** 这些文件的编辑不会出现在 `git status` 里 —— 贡献者 `bun install` 后改动 `bun.lock` 不会被看见，lockfile drift 静默落地。文件都已在 index 中，所以只改 ignore 文件即可，无需重新 `git add`：

| 文件 | 当前拦截规则 | 方向 |
|---|---|---|
| `bun.lock` | `*.lock` | **保持 track** —— 加 `!bun.lock` |
| `.vscode/launch.json`、`tasks.json` | `.vscode/*` | **保持 track**（贡献者有用）—— 加否定项 |
| `.claude/agents/hello-agent.md` + `skills/` 3 个 | `.claude/` + `teach-me` | **保持 track**（项目资产）—— 上述 glob 改写 + `/teach-me/` 锚定，两者缺一不可 |
| `src/commands/config/*.tsx,ts` | `.git/info/exclude` | 由 1a 解决 |
| `teach-me/` 3 个文件 | `teach-me` | **取消 track** —— 个人 vLLM 学习笔记（`learner-profile.md` 是 vLLM 学习偏好记录），非发行物。`git rm --cached`，文件留在磁盘 |

注意最后两行的 `teach-me` 是**两个不同的东西**：根目录 `teach-me/`（个人笔记，取消 track）和 `.claude/skills/teach-me/`（项目 skill，保持 track）。锚定成 `/teach-me/` 后前者仍被忽略、后者被解放，一条改动同时满足两个相反需求。

**同时删除的死规则：**

- `.agents/__pycache__/` —— 被 `.agents/` 和 `__pycache__/` 双重覆盖。**但 `.agents/` 本身是目录形式**，与 `.claude/` 同类；此处只删冗余的 `__pycache__` 子规则，不改 `.agents/`（无 tracked 文件需要解放，不必冒险）。
- `.codex` 否定块 —— 目标目录不存在，整块为死重。
- 已验证不存在的目标：`.codex`、`.agents`、`.swarm`、`Claude-*.txt`。

**保留**：`coverage`/`dist`（标准构建产物，会重现）、`.omc`（活跃，10 处嵌套位置）、`.omx/`、以及已经正确锚定的 `/*.png`。

### 1c. 修复 `packages/cloud-artifacts/.gitignore` 的损坏模式

该文件像是经过 Markdown 渲染器，`*` 被吃掉或被转义。已验证的实际失效：

```
tsconfig.tsbuildinfo   *** 未被忽略 ***
server.pid             *** 未被忽略 ***
coverage.lcov          *** 未被忽略 ***
pkg.tgz                *** 未被忽略 ***
```

原因：`\*.tsbuildinfo` 中的反斜杠使 git 匹配**字面量星号**，而非通配。对比同级 `packages/acp-link/.gitignore:28` 的正确形式 `*.tsbuildinfo` 工作正常。

**改动**（两个 agent 独立确认为同一组 10 处，且已穷举扫描确认无遗漏）：
- 去掉 5 处转义反斜杠：第 20、29、62、89、159 行（`\*.pid.lock`、`\*.lcov`、`\*.tsbuildinfo`、`\*.tgz`、`.pnp.\*`）
- 修复 5 处 `_` → `*`：第 4 (`_.log`)、5 (`npm-debug.log_`)、13 (`report.[0-9]_.[0-9]_.[0-9]_.[0-9]_.json`，一行 4 处)、18 (`_.pid`)、19 (`_.seed`)
- `packages/acp-link/.gitignore` 同样修复第 15、16 行的 `_`。该文件第 28 行 `*.tsbuildinfo` 形式正确、实测生效，是本组修复的**正对照** —— 改完后两个文件的该行应完全一致。

### 1d. 其他 ignore 文件的同类缺陷（审计新增）

- **`packages/remote-control-server/.gitignore:1`** 裸 `data` —— 与根 `.gitignore` 完全同一缺陷类，会吞掉该包内任意深度的 `data/` 源码目录。锚定为 `/data/`。
- **`.dockerignore:4`** `.githooks` —— 死规则，本仓库用 husky（`package.json` 的 `prepare: husky`），没有 `.githooks/` 目录。删除。
- **`biome.json:13`** `!!**/.claude/workflows` —— 已实测确认为死排除：`.claude/workflows` 不存在，实际目录是 `.claude/workflow-runs/`。改成 `!!**/.claude/workflow-runs`（保留原意图：不让 biome 碰运行产物），不是简单删掉 —— 删掉会让 workflow-runs 里的产物进入 lint 视野。
- **`.mintignore`** 全文只有两行（`src/` 和 `packages/`），导致 `/.impeccable`、`/CLAUDE`、`/AGENTS`、`/progress` 这些内部文档全部对外可访问（实测 200）。补上这几项 —— 其中 `progress.md` 在阶段 3 会被删，但 `CLAUDE.md`/`.impeccable.md`/`AGENTS.md` 会长期存在，且 `AGENTS.md` 是指向 `CLAUDE.md` 的 symlink，两个名字都要排除。

## 阶段 2：新增 `.gitattributes`

当前缺失。已验证 `docs/testing/SLASH-COMMANDS-TEST-CHECKLIST.md` 含 CRLF —— 正是该文件能防止的问题（不过该文件在阶段 3 会被删，规则仍对未来生效）。

**renormalize 风险已实测为零**（这是加 `.gitattributes` 唯一的真实危险，必须先排除）。全仓 3662 个 track 文件的 EOL 分布：

```
3644  i/lf w/lf        ← 已是 LF，eol=lf 对它们是 no-op
  16  i/-text w/-text  ← 二进制（9 png + 6 node + 1 特例，见下）
   1  i/crlf w/crlf    ← 唯一的 CRLF 文件，恰好就是阶段 3 要删的那个
   1  i/ w/            ← 空 EOL 标记
```

用 `.git/info/attributes` 模拟规则全量生效后实测：`git status --porcelain -uall` 输出 **0 行**，EOL 分布不变。故**不需要 `git add --renormalize`**，也不会把无关文件卷进本次提交。

**明确不执行 `git add --renormalize`。** 上表已证明它是 no-op（唯一的 CRLF 文件恰好在阶段 3 的删除集内 —— 阶段 3 之前它会被 stage 1 个文件，之后是 0 个），而 renormalize 是全仓操作，一旦有意外命中就会把无关文件卷进本次提交，难以拆分。零收益 + 非零风险 = 不做。

那 16 个 `i/-text` 里有一个意外项：`src/services/SessionMemory/__tests__/multiStore.test.ts`。查明原因是它含 2 个**故意的** NUL 字节（测试用例断言"store 名含 null byte 应被拒绝"）。但首个 NUL 在字节偏移 11479，**超出 git 二进制探测的前 8000 字节窗口**，所以实测 `git diff` 对它仍然可读（已验证）。`ls-files --eol` 报 `-text` 是因为它做全文扫描 —— 两者判定分歧的根源就在这里。**结论：无需为它加 `.gitattributes` 特例规则。**

顺带的可选清洁项（审计建议，非必需）：把该文件里的 2 个字面 NUL 字节改写成 `\0` 转义。等价、不改测试语义，且让文件回到纯文本，`ls-files --eol` 不再报 `-text`。这是唯一一处"源码里嵌了不可见控制字符"，与"清洁"目标一致。若改动引起任何测试行为疑虑，直接跳过 —— 它不影响其他任何阶段。

已 track 的二进制清单：`.node` 6 个（438-509KB/个）、`.png` 9 个（42MB 合计，仓库主要体积）、`.svg` 4 个。

```gitattributes
* text=auto eol=lf

*.node  binary
*.png   binary
*.svg   -diff

bun.lock         linguist-generated -diff
contributors.svg linguist-generated -diff
```

`eol=lf` 在此仓库尤其重要，因为它 ship Windows 目标产物（`x64-win32/audio-capture.node`）—— 最可能被 CRLF 转换破坏的受害者。`bun.lock`（596KB）与 `contributors.svg`（2.7MB）都是机器生成、diff 不可读。

## 阶段 3：删除过程产物（58 + 审计新增 3 = 61 个文件）

体积：原 58 项实测 **1.05MB**（原计划写 1.2MB 偏高）；新增 3 项体积可忽略。#3 verifier 的克隆仓库 dry run 显示全部 4 阶段合计 `24258 deletions(-)`。

判定标准不是"是否被链接"（`docs/features/ssh-remote.md` 无人链接但记录着活跃 feature flag），而是：**该文档描述"当前是什么"（保留）还是"过去做了什么"（删除）**。

有先例：`14c46df8 docs: 清理垃圾文档` 曾一次删除 31 个文档、8343 行。

### 根目录（4）
- `code-review-2026-07-30.md`（21KB 审查报告）
- `progress.md`（code review 进度记录，末次改动 2026-05-05）
- `DEV-LOG.md`（51KB 开发日志，用户已明确"删掉"。已确认零引用，且**其中 2 个内部引用已经是死链** —— 原计划写"引用的 14 个文档"没有有效计数依据，那个数字不要用；"2 个已死"是精确的）
- `mint.json`（被 `docs.json` 取代的 Mintlify v1 配置。删除安全性见上文"已验证的关键约束"—— nav 成员资格不决定可访问性）

### `docs/` 深度 1（9）
`code-review-fix-plan-2026-07-30.md`、`feature-plan-2026-07-30-agent-enhancements.md`、`feature-plan-2026-07-30-agent-enhancements-batch2.md`、`acp-compliance-audit.md`、`acp-refactor-plan.md`、`ink-tui-deep-audit.md`、`memory-leak-audit.md`、`memory-peak-analysis.md`、`performance-reporter.md`

后三者均为带日期、绑定具体 commit 的调研报告（如 `memory-peak-analysis.md` 标注"修复 commit `ef10ad28` + `ab0bbbc4`，调研完成"）。

### `docs/design/`（4 of 5）
`compact-progress-ui-fix-plan-2026-08-03.md`、`context-compression-audit-2026-07-31.md`、`context-compression-fix-plan-2026-08-03.md`、`kimi-code-borrow-recommendations.md`

审计与计划两份互相引用，构成闭环，同删。`kimi-code-borrow-recommendations.md` 标注"已判决"且引用本机路径 `/Volumes/work/software/install/kimi-code`。

**保留** `tool-search-design-guide.md` —— 是架构参考（"ToolSearch 设计指南"），描述当前实现。

### 整目录删除（29）
- `docs/task/` 8 个 —— 任务清单。**修正**：只有 3 个带 `状态: DONE` 行，不是"均标注 DONE"（`task-016-backward-compat-tests.md` 完全没有状态行）。删除依据因此不是状态标记，而是内容性质：它们记录的是 `feat/integrate-5-branches` 分支上"当时要做什么"，且引用的 `docs/features/daemon-restructure-design.md` 与本批同删。其中 `task-016` 含一份 `claude ps` → `claude daemon status` 的 8 行向后兼容矩阵，是全批唯一有长期参考价值的内容 —— 但该兼容行为由代码与 `--help` 输出自证，不需要文档留存。
- `docs/superpowers/` 14 个 —— 带日期的 plans/specs/reviews，内部互链、对外孤立
- `spec/` 7 个 —— 两个 feature 的 spec-design/plan/human-verify，完全自包含

### `docs/internals/`（3）
`autonomy-jira.md`、`agent-comm-fix-jira-tasks.md`、`agent-comm-fix-questions.md` —— JIRA 草稿与问题清单

### `docs/features/`（6）
`computer-use-mcp-test-report.md`（测试报告）、`daemon-restructure-design.md`、`stub-recovery-design-1-4.md`（后两者仅被 `docs/task/` 引用，随之同删）、`growthbook-enablement-plan.md`（仅被 `DEV-LOG.md` 引用，随之同删）

外加两份方案文档（已确认零引用，用户已明确"两个都删"）：
- `computer-use-architecture-v2.md` —— **修正原计划的"从未执行"判断**：该重构其实**大部分已经落地**，只有 §5 提议的删除项没做（`packages/@ant/computer-use-swift/src/backends/` 下 `win32.ts`、`linux.ts` 仍在原处）。所以删除理由不是"提案未落地所以是废纸"，而是"提案已被实现取代，文档描述的是过去的迁移过程，不是当前架构"—— 恰好落在本阶段的判定标准里。
- `computer-use-windows-enhancement.md` —— Windows 增强实施计划。其第 4 行引用的 `windows-ai-desktop-control.md` 本身就不存在，即当前已带死链。

删除后 `docs/features/computer-use.md`（README URL 承重，保留）少 **1** 个入链（不是 2 个），无影响。

### 其他（3）
`docs/reviews/2026-07-29-stream-lifecycle-hardening-review.md`、`docs/test-plans/openclaw-autonomy-baseline.md`、`docs/testing/SLASH-COMMANDS-TEST-CHECKLIST.md`

### 审计新增的删除项（3）

同一判定标准下漏掉的三项：

- **`docs/agent/sur-loop-scheduled-oom.md`** —— 492 行、零入链的 SUR 事故报告，完全符合"记录过去做了什么"的删除标准。注意与它同目录的 `sur-skill-overflow-bugs.md` **必须保留**（被 `scripts/defines.ts:85` 与 `src/services/skillSearch/featureCheck.ts:20` 引用）—— 两者名字相近，删的时候要看准。
- **`scripts/rcs-ccb.sh`** —— 197 字节，2 行（1 行还是注释掉的 localhost 变体），无 shebang，mode 644（即根本不可直接执行）。**且比审计报告说的更该删：它把 `ACP_RCS_TOKEN=test-my-key` 硬编码在 tracked 文件里，还带一个写死的生产 URL `https://remote-control.claude-code-best.win/`。** 即使那是个明显的占位 token，"发行版仓库里躺着一行 token= 的 shell 脚本"本身就是不该有的形状 —— 它会被扫描器命中，也会教坏照抄的人。删除，无需替代（`package.json` 的 `rcs` script 已覆盖启动路径）。
- **`codecov.yml`** —— 死配置。`ci.yml:50-59` 的 codecov 上传步骤已被整段注释掉（注释原文："codecov 坏了，老是失败，先注释掉"），这个配置文件当前无任何消费者。

### 连带的代码注释修正（必须同步，否则制造新 dead pointer）
- `scripts/defines.ts:102` 注释引用 `docs/feature-plan-2026-07-30-agent-enhancements.md` → 删除路径引用，保留"借鉴 kimi-code"语义
- **保留** `docs/agent/sur-skill-overflow-bugs.md` —— 被 `scripts/defines.ts:85` 与 `src/services/skillSearch/featureCheck.ts:20` 引用

## 阶段 4：修正 dead pointer（5 个修改点 / 4 个文件）

原计划只列了 2 处。补全扫描后实为 4 条死链、5 个修改点。

**`CLAUDE.md:75`** —— 整行为 `详细的测试规范、覆盖状态和改进计划见 \`docs/testing-spec.md\`。`，该文件已于 `14c46df8` 删除。现存 test 相关文档中无一可替代（`docs/testing/SLASH-COMMANDS-TEST-CHECKLIST.md` 与 `docs/test-plans/openclaw-autonomy-baseline.md` 都在阶段 3 的删除集里）。**修法：整行删除。** 该行上文（`:43-73`）已完整列出测试命令，删掉不丢信息。

**`README.md:22`** —— Artifacts 那格含两个链接：`[8 小时复刻报告](./docs/blog/2026-06-20-cloud-artifacts-8h-recap.md)`（`docs/blog/` 整个目录都不存在）· `[在线 demo](https://cloud-artifacts...)`（活）。**修法：死链改指 `./packages/cloud-artifacts/README.md`**，保留在线 demo。该 README 存在且被 `CLAUDE.md` 列为此功能的权威文档（"详见 `packages/cloud-artifacts/README.md`"）—— 比单纯删链更好，保住了这一格的文档入口。

**`docs/safety/miit-warning-response.mdx:72`** —— 引用**同一个**不存在的博客文件，但用的是 GitHub 绝对 URL（`https://github.com/claude-code-best/claude-code/blob/main/docs/blog/...`），所以按相对路径 grep 抓不到。该文件在 `docs.json` nav 中（承重，不删），**必须修**。同样改指 `packages/cloud-artifacts/README.md` 的 GitHub URL 形式。

**`README.md:6` / `README_EN.md:6` 的 LICENSE badge** —— 双重损坏：链接指向不存在的 `/blob/main/LICENSE`，且 `img.shields.io/github/license/...` 依赖 GitHub license API，无 LICENSE 文件时渲染为 "license unknown"。这是仓库最显眼位置的坏 badge。**修法：删掉这一行 badge。** 这是纯减法，且**不主张任何许可** —— 与用户"LICENSE 保持不动"的决定一致（不新增 LICENSE，同时也停止声称有一个）。

> 方法论修正：原计划的死链审计只查了相对路径链接，漏掉了"指向本仓库的 GitHub 绝对 URL"这一类。已补全仓扫描（`git ls-files '*.md' '*.mdx' '*.json' '*.yml'` × `blob|tree` URL 逐个校验），确认该类死链共 3 条，即上述 README×2（LICENSE）+ miit×1（blog）。`README_EN.md` 没有 Artifacts 那一行，无需同步改。

**`docs.json:173-174` + `docs/introduction/what-is-claude-code.mdx:5` 的 og-cover.png —— 本轮不修，仅记录。** 三处都指向 `https://ccb.agent-aura.top/docs/images/og-cover.png`，而 `docs/images/` 下确实没有 `og-cover.png`（该目录恰好 9 个 PNG，无此文件）。看起来是明确的死链，**但探测证据被污染了**：同一前缀下探测一个确定存在的 `images/agentic-loop.png` 也返回 404，说明我用的 URL 前缀本身就不对（线上实际服务路径未能确定）。在前缀没搞清之前无法区分"图片真的缺失"和"我探错了地址"，贸然删掉 og:image 会让社交分享卡片失去封面图 —— 属于减法造成的功能退化。**决定：留到能确认线上服务前缀之后单独处理**，不塞进本次清理。

## 阶段 5：文档同步（AGENTS.md 第 7 步）

第 7 步要求"如涉及接口、行为、配置、架构或使用方式变化，必须同步更新相关文档"。本次有两处触发：

**5a. 阶段 0 改变了 `package.json` 的发布语义** —— `dependencies` 少一项、`files` 白名单收窄。这两项都不在任何文档里描述（`CLAUDE.md` 的 Architecture 段讲的是构建管线，不是发布清单），所以无需改文档，但**必须写进 commit message**：说明 core-utils 移入 devDependencies 是因为 npm 不重写 `workspace:` 协议，避免将来有人"修回去"。

**5b. `CLAUDE.md:129` 的核心工具数已过期** —— 写的是"`CORE_TOOLS` 白名单常量（38 个核心工具名）"，实测 `src/constants/tools.ts` 的 `CORE_TOOLS` 是 **29** 个（逐条数清；`...SHELL_TOOL_NAMES` 展开为 2 个：`Bash` + `PowerShell`）。既然本次已经要编辑 `CLAUDE.md`（删第 75 行死指针 + 加"文档保留标准"），顺手把 38 改成 29。

这属于"文档声称的事实与代码不一致"，正是发行版清洁度的一部分 —— 一个数字错了的白名单说明比没有说明更容易误导。注意**不要**顺手去核对同段的"60 个工具目录"等其他计数：那是另一个量级的核查工作，本轮不扩大范围，只改已实测确认的这一处。

## 执行顺序（一次推进到底，无阶段性暂停）

顺序不是任意的，有三处真实依赖：

```
1.0 备份（cp exclude + tar teach-me）        ← 必须最先，两处不可 git 回滚
 ↓
阶段 3 删除 61 个文件                          ← 放在 .gitattributes 之前
 ↓                                              唯一的 CRLF 文件在删除集内，
 ↓                                              先删则阶段 2 的 renormalize 面为 0
阶段 2 新建 .gitattributes
 ↓
阶段 1（1a → 1b 整体改写 → 1c → 1d）           ← 1b 内部：锚定 teach-me 与
 ↓                                              .claude/* 改写必须同一次编辑
阶段 4 修 dead pointer + 阶段 5 文档同步        ← 依赖阶段 3 已删完，
 ↓                                              否则改的是还没死的链接
验证全套 → 分 commit 提交
```

阶段 0 与其余阶段无依赖，可最先做（它是 P0，且独立成 commit）。

**遇到问题时的处理**（AGENTS.md：不暂停、制定子计划递归完成）：ignore 语义类问题一律用上文的 `assert_ignored`/`assert_not_ignored` 现场二分定位到具体规则行，不要靠推理；删除类问题若发现某文件仍有活引用，就地判定"改引用"还是"保留该文件"，按判定标准执行，不回头问。

## 关键文件清单

| 路径 | 操作 |
|---|---|
| `.gitignore` | **一次整体改写**：`.claude/` → `.claude/*` + 逐层开洞、锚定 3 条、加否定项、加 `.drafts/` 排除、删死规则。按内容匹配，不按行号 |
| `.git/info/exclude` | `config/` → `/config/`（先 `cp` 备份，不可 git 回滚）|
| `packages/cloud-artifacts/.gitignore` | 修 10 处损坏模式 |
| `packages/acp-link/.gitignore` | 修 2 处 `_` |
| `packages/remote-control-server/.gitignore` | 裸 `data` → `/data/` |
| `.dockerignore` | 删死规则 `.githooks` |
| `biome.json` | 修/删第 13 行失效排除 |
| `.mintignore` | 补 `/CLAUDE`、`/AGENTS`、`/.impeccable` |
| `.gitattributes` | 新建 |
| `package.json` | core-utils 移入 devDependencies、收窄 `files` |
| `scripts/postinstall.cjs` | `require('undici')` 加 try/catch |
| `CLAUDE.md` | 删 dead pointer（第 75 行）+ 第 129 行 38 → 29 + 加"文档保留标准"小节 |
| `README.md` | 删 LICENSE badge（第 6 行）、死博客链接改指 cloud-artifacts README（第 22 行）|
| `README_EN.md` | 删 LICENSE badge（第 6 行）|
| `docs/safety/miit-warning-response.mdx` | 第 72 行 GitHub 绝对 URL 死链改指 |
| `scripts/defines.ts` | 第 102 行注释去掉已删文档路径（`:85` 的引用**保留**）|
| 61 个文档/配置 | `git rm` |
| `teach-me/` 3 个 | `git rm --cached`（留在磁盘，先 tar 备份）|

## 验证

1. **ignore 修正生效**（核心回归 —— 这些当前全部失败）。

   ⚠️ **不能直接用 `git check-ignore` 配"期望无输出"做断言** —— 它在**未命中时 exit 1**，所以"无输出"同时也是失败退出码，会中断 `&&` 链、并在任何 `set -e` 脚本里直接终止执行。原计划的写法是反的。必须先包两个语义明确的断言函数：

   ```bash
   assert_ignored()     { git check-ignore -q --no-index "$1" \
                            && echo "OK   ignored: $1" \
                            || { echo "FAIL not ignored: $1"; return 1; }; }
   assert_not_ignored() { git check-ignore -q --no-index "$1" \
                            && { echo "FAIL ignored: $1"; return 1; } \
                            || echo "OK   visible: $1"; }

   # 潜伏吞码路径 —— 必须可见
   assert_not_ignored src/commands/config/NEW.ts
   assert_not_ignored tests/data/f.json
   assert_not_ignored src/utils/logs/logger.ts
   assert_not_ignored packages/remote-control-server/src/data/schema.ts
   # 已 track 的项目资产 —— 必须可见
   assert_not_ignored bun.lock
   assert_not_ignored .vscode/launch.json
   assert_not_ignored .claude/agents/hello-agent.md
   assert_not_ignored .claude/skills/teach-me/SKILL.md
   assert_not_ignored .claude/skills/teach-me/references/pedagogy.md
   # 本地状态 / 草稿 —— 必须仍被忽略
   assert_ignored teach-me/learner-profile.md
   assert_ignored config/mcporter.json
   assert_ignored .claude/skills/.drafts/draft-refactor-api-gateway/SKILL.md
   ( cd packages/cloud-artifacts && assert_ignored tsconfig.tsbuildinfo \
                                 && assert_ignored server.pid \
                                 && assert_ignored coverage.lcov \
                                 && assert_ignored pkg.tgz )
   ```

   `--no-index` 是必需的：被测路径里有多个已在 index 中的文件，不加这个 flag，git 会因"已 track"而拒绝报告 ignore 状态，断言全部失真。

   收尾的总量断言（唯一一条可以直接看输出的）：
   ```bash
   git ls-files -i -c --exclude-standard   # 期望：0 行（当前 12 行）
   git status --porcelain -uall            # 期望：只有本次预期的改动，无意外新增
   ```

2. **无 dead 引用残留**。原计划写的"重跑 nav 完整性脚本"**不存在** —— 仓库里没有这个脚本，照字面执行会卡住。改用内联校验（把 `docs.json` 的 nav 全部展开，逐条确认对应文件存在）：

   ```bash
   python3 - <<'EOF'
   import json, pathlib
   cfg = json.load(open('docs.json'))
   pages, missing = [], []
   def walk(n):
       if isinstance(n, str): pages.append(n)
       elif isinstance(n, list): [walk(x) for x in n]
       elif isinstance(n, dict): [walk(v) for k, v in n.items() if k in ('pages','groups','tabs','navigation','anchors')]
   walk(cfg.get('navigation'))
   for p in pages:
       if not any(pathlib.Path(f'{p}{e}').exists() for e in ('.mdx','.md')): missing.append(p)
   print(f'nav={len(pages)} missing={len(missing)}'); [print(' ', m) for m in missing]
   EOF
   # 期望：nav=62 missing=0
   ```

   再逐条 grep 已删路径确认无残留引用（重点：`docs/testing-spec.md`、`docs/blog/`、`feature-plan-2026-07-30-agent-enhancements.md`、`daemon-restructure-design.md`、`stub-recovery-design-1-4.md`、`growthbook-enablement-plan.md`）。
3. **阶段 0 的发布阻塞已解除**（这是"发行版"的字面验收项）：
   ```bash
   npm pack --dry-run --json 2>/dev/null | grep -c 'workspace:'   # 期望：0
   node -e "const p=require('./package.json');
     const bad=Object.entries(p.dependencies).filter(([,v])=>v.startsWith('workspace:'));
     console.log(bad.length===0?'OK no workspace: in dependencies':'FAIL '+JSON.stringify(bad))"
   ```
   `files` 收窄的效果需在**有本地 `dist/` 残留时**验证才有意义 —— 若当前 `dist/` 干净，`npm pack --dry-run` 看不出差别，此时只做静态复核（确认 `files` 里不再有裸 `dist`）即可，不必为验证而故意跑一次 `build.sh` 造 200MB 产物。

4. **`bun run precheck` 零错误**（typecheck + lint + boundaries + test）—— CLAUDE.md 要求的硬门槛。本轮触及 `scripts/postinstall.cjs`、`scripts/defines.ts`、`package.json`、以及可选的 `multiStore.test.ts`，必须全量跑。基线已知：typecheck exit 0、boundaries `1209 reverse imports == baseline`（改动不涉及 `packages/**` 的 import，该数字应保持不变 —— 若变了说明误改了包内代码）。

5. **构建未破坏**：`bun run build:vite`，确认 `dist/cli-node.js` 与 `dist/cli-bun.js` 生成（`package.json` 的 `bin` 三个入口全指向这两个文件，缺一即发行物不可用）。

6. **`.gitattributes` 生效**：
   ```bash
   git check-attr -a bun.lock contributors.svg \
     vendor/audio-capture/x64-win32/audio-capture.node
   git ls-files --eol | awk '{print $1,$2}' | sort | uniq -c   # 期望：分布与阶段 2 表格一致
   ```
   重点确认 Windows 目标产物 `.node` 拿到 `binary`（它是 CRLF 转换最可能的受害者），且 `git status --porcelain` 仍为预期集合 —— 若 `.gitattributes` 意外触发了重规范化，这里会冒出一批无关文件。

7. **提交前终检**：
   ```bash
   git status                    # teach-me/ 文件应仍在磁盘，仅从 index 移除
   ls teach-me/                  # 3 个文件都在
   git ls-files teach-me/        # 期望：0 行
   ```

## 计划文档自身的归属（AGENTS.md 第 2 步 vs 阶段 3 的自指矛盾）

`AGENTS.md` 第 2 步要求"将该计划以 Markdown 文件格式保存到 `docs/` 目录中"。但本计划的阶段 3 删除的正是"`docs/` 下带日期的计划文档"—— 如果把它提交进 `docs/`，它就是自己删除标准的完美反例，下一轮清理第一个删的就是它。先例也支持这点：`14c46df8` 一次删了 31 个文档，本身没有配套计划文档留存。

**解法（闭环，不违反任一方）：**

1. 执行期间把本计划写到 `docs/repo-cleanup-plan-2026-08-03.md` —— 满足 AGENTS.md 第 2 步的字面要求，执行过程有据可查。
2. 执行完成后按阶段 3 的同一标准删除它（它描述"过去做了什么"，不是"当前是什么"）。它的内容通过 commit message 与 git history 永久可追溯，不需要在工作区留副本。
3. 真正需要长期留存的是**规则本身**，不是这次的执行过程。所以在 `CLAUDE.md` 补一小节"文档保留标准"：

   > **文档保留标准**：描述"当前是什么"的文档保留（架构说明、feature 文档、设计指南）；描述"过去做了什么"的文档删除（审计报告、带日期的修复计划、任务清单、调研记录、测试报告）。规则是资产，过程是垃圾 —— 过程属于 git history，不属于工作区。

   这一条是本轮清理唯一值得沉淀的产物：它把一次性的判断变成可复用的标准，下次不必重新论证。同时它也是 AGENTS.md 第 7 步（"如涉及…使用方式变化，必须同步更新相关文档"）在本任务下的落点。

## 回滚

各阶段的回滚代价不对称，按此顺序理解风险：

| 改动 | 回滚方式 |
|---|---|
| `.git/info/exclude` | **不受版本控制** → `cp /tmp/git-info-exclude.bak .git/info/exclude` |
| `teach-me/` 磁盘文件 | `git rm --cached` 后成为未 track 文件，`git clean -Xd` 会清掉 → `tar xzf /tmp/teach-me.bak.tgz` |
| 其余全部（含 61 个删除、所有 ignore/config 编辑、`.gitattributes` 新建） | 提交前 `git checkout -- . && git clean -fd <限定路径>`；提交后 `git revert`。全部 forward-only，无历史重写 |

单条提交 vs 分阶段提交：阶段 0（发布链路）与阶段 1（ignore 语义）的性质完全不同，建议至少拆成两个 commit，便于单独 revert。阶段 3 的 61 个删除自成一个 commit。

## 已确认的执行安全性（#3 verifier 实测）

这些是"执行前担心会炸、实测不会炸"的项，避免执行时反复自我怀疑：

- **biome 不读 `.gitignore` / `.gitattributes` / `*.md`** —— 阶段 1、2、3 的改动完全不进 lint 视野。
- **`knip` 不在 `precheck` 里**（`precheck` = typecheck + `check:fix` + `check:boundaries` + test），所以删文档不会触发 unused-export 报错。
- **`check-boundaries.ts` 只扫 `packages/**`** —— 删 `docs/`、改根配置都不影响。基线实测 `1209 reverse imports == baseline`。
- **0 个测试引用被删路径** —— 阶段 3 不会破测试。
- **baseline `typecheck` exit 0** —— 改 `scripts/defines.ts:102` 的注释后需复验（那是注释，但该文件在 tsc 视野内）。
- **克隆仓库全 4 阶段 dry run**：`67 files changed, 32 insertions(+), 24258 deletions(-)`，tracked-but-ignored 12 → 0，nav 62 条 0 missing。

## 不做的事

- **不重写历史 / 不 force-push** —— 分支已与 origin 同步，force-push 具破坏性且需显式授权。所有清理为新提交。
- **不加 LICENSE**（用户明确决定）、不加 CODEOWNERS / dependabot / PR 模板 —— 用户要求删减，非新增脚手架。
- **不动 42.10MB 的 `docs/images/`（9 个 PNG）** —— 是仓库主要体积。**但原计划给的理由"被线上文档引用"是错的**：实测只有 3 个被引用（`agentic-loop` ← `the-loop.mdx`；`architecture-layers` + `data-flow` ← `architecture-overview.mdx`），另 **6 个零引用、约 28MB**。真正的不做理由变成：这些 URL 已知是线上活的，而我尚未确认 Mintlify 的实际图片服务前缀（见上文 og-cover 那段 —— 连确定存在的图片都探出 404），在能可靠区分"真无人用"和"我探错地址"之前删 28MB 二进制是不可逆风险。压缩 / LFS / 删除零引用项都是独立议题，需单独一轮 + 单独决策。
- **不修 `src/skills/bundled/claude-api/`** —— `claudeApiContent.ts` import **26** 个不存在的 `.md`（不是 27），靠 `claudeApi.ts:190` 的懒加载动态 import 掩盖。既存问题，与本次清理无关，仅记录。
- **不动 `docs/design/ps-shell-selection.md` 的 5 处死代码引用**（不是 4 处；`frontmatterParser.ts:56`、`hooks.ts:828,865` 等）—— 同为既存问题，可另开一轮。
- **不改 `docs/images/` 之外的任何二进制** —— 6 个 `.node`（438-509KB/个）、4 个 `.svg` 均为必需产物。
