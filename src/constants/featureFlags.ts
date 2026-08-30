/**
 * Feature flag registry — the single source of truth for all `feature('X')`
 * flag names used with `import { feature } from 'bun:bundle'`.
 *
 * 借鉴 kimi-code 的 flags/registry.ts 模式：`as const` 数组派生出字面量联合
 * 类型 `FeatureFlagName`，使 `feature()` 调用获得 tsc 拼写检查与自动补全。
 * 拼错的 flag 名（如 `feature('BRIGDE_MODE')`）将直接产生编译错误，而不是
 * 静默返回 false。
 *
 * 新增 flag 的步骤：
 *   1. 在下方数组中按字母序追加 flag 名（附一句中文说明）。
 *   2. 若需要默认启用，在 scripts/defines.ts 的 DEFAULT_BUILD_FEATURES 中
 *      追加同名条目（该列表通过 `satisfies` 校验必须是本注册表的子集）。
 *   3. 运行时通过 FEATURE_<NAME>=1 环境变量启用。
 *
 * 注意：本文件必须保持零依赖、零副作用（纯常量），scripts/defines.ts 以
 * type-only import 引用它。
 */
export const FEATURE_FLAGS = [
  'ABLATION_BASELINE', // 消融实验基线模式
  'ACP', // ACP 代理协议，支持外部 agent 接入
  'AGENT_LAUNCH_THROTTLE', // 子代理启动限速（API 限流冷却期内暂缓新启动）
  'AGENT_MEMORY_SNAPSHOT', // Agent 记忆快照
  'AGENT_TRIGGERS', // 本地 Agent 触发器（工具调用时启动子代理）
  'AGENT_TRIGGERS_REMOTE', // sessionIngress 远程触发器
  'ALLOW_TEST_VERSIONS', // 允许安装测试版本
  'AUTOFIX_PR', // /autofix-pr 命令
  'AUTO_THEME', // 跟随终端自动切换主题
  'AWAY_SUMMARY', // 离线摘要（用户离开后生成总结）
  'BASH_CLASSIFIER', // Bash 命令分类器
  'BG_SESSIONS', // 后台会话管理（ps/logs/attach/kill）
  'BREAK_CACHE_COMMAND', // 手动打破 prompt cache 的命令
  'BRIDGE_MODE', // Remote Control / Bridge 模式
  'BUDDY', // 陪伴宠物角色（Squirtle Waddles）
  'BUILDING_CLAUDE_APPS', // Claude Apps 构建支持
  'BUILTIN_EXPLORE_PLAN_AGENTS', // 内置 Explore/Plan 子代理类型
  'CACHED_MICROCOMPACT', // 带缓存的微压缩
  'CCR_AUTO_CONNECT', // CCR 自动连接
  'CCR_MIRROR', // CCR 镜像
  'CCR_REMOTE_SETUP', // CCR 远程配置
  'CHICAGO_MCP', // Chicago MCP 集成（内部代号）
  'COMMIT_ATTRIBUTION', // Git 提交归属追踪（记录 AI 辅助贡献）
  'COMPACT_PRESERVE_USER_MESSAGES', // compact 时保留真实用户消息 HEAD+TAIL（借鉴 kimi handoff）
  'COMPACT_TAIL_PRESERVATION', // compact 后逐字保留最近 N 个 API round（借鉴 opencode tail preservation）
  'PRECOMPUTED_COMPACT', // 在下一次压缩前异步准备摘要，失败时回退普通 compact
  'COMPACTION_REMINDERS', // 压缩提醒
  'CONNECTOR_TEXT', // Connector 文本块类型，扩展 API 内容格式
  'COORDINATOR_MODE', // 多 worker 编排模式
  'COWORKER_TYPE_TELEMETRY', // Coworker 类型遥测
  'CROSS_SESSION_MESSAGING', // 跨会话 Agent 发现、寻址、收发与回执
  'DAEMON', // 守护进程模式，长驻 supervisor 管理后台 worker
  'DOWNLOAD_USER_SETTINGS', // 下载用户设置
  'DUMP_SYSTEM_PROMPT', // --dump-system-prompt 快速路径
  'ENHANCED_TELEMETRY_BETA', // 增强遥测 beta
  'EXPERIMENTAL_SEARCH_EXTRA_TOOLS', // 工具搜索预取管道（TF-IDF 索引）
  'EXPERIMENTAL_SKILL_SEARCH', // 技能搜索
  'EXTRACT_MEMORIES', // 每次 turn 结束提取记忆
  'FILE_PERSISTENCE', // 文件持久化
  'FILE_MUTATION_QUEUE', // 同文件 mutation 串行化（跨 query loop 文件写互斥）
  'GOAL', // 持久线程目标命令（src/services/goal）
  'HARD_FAIL', // 硬失败模式
  'HISTORY_PICKER', // 历史记录选择器
  'HISTORY_SNIP', // 历史剪藏（已禁用）
  'HOOK_PROMPTS', // Hook 提示词
  'IS_LIBC_GLIBC', // 构建目标 libc 为 glibc
  'IS_LIBC_MUSL', // 构建目标 libc 为 musl
  'KAIROS', // Kairos 定时任务系统核心
  'KAIROS_BRIEF', // Kairos 定时摘要
  'KAIROS_CHANNELS', // Kairos 通知渠道
  'KAIROS_GITHUB_WEBHOOKS', // Kairos GitHub webhook 触发
  'KAIROS_PUSH_NOTIFICATION', // Kairos 推送通知
  'LODESTONE', // 上下文锚点，优化长对话相关性检索
  'MCP_RICH_OUTPUT', // MCP 富输出渲染
  'MCP_SKILLS', // MCP 技能支持
  'MEMORY_SHAPE_TELEMETRY', // 记忆结构遥测
  'MESSAGE_ACTIONS', // 消息操作菜单
  'MONITOR_TOOL', // Monitor 工具，流式监控后台进程输出
  'NATIVE_CLIENT_ATTESTATION', // 原生客户端证明
  'NATIVE_CLIPBOARD_IMAGE', // 原生剪贴板图像读取
  'NEW_INIT', // 新版 /init 流程
  'OVERFLOW_TEST_TOOL', // 溢出测试工具
  'PERFETTO_TRACING', // Perfetto 性能追踪
  'PIPE_IPC', // 管道 IPC
  'POOR', // 穷鬼模式，跳过 extract_memories 等减少消耗
  'POWERSHELL_AUTO_MODE', // PowerShell 自动模式
  'PROACTIVE', // 主动建议
  'PROMPT_CACHE_BREAK_DETECTION', // 检测 prompt cache 是否被打破
  'QUICK_SEARCH', // 快速搜索
  'REACTIVE_COMPACT', // 响应式压缩
  'RUN_SKILL_GENERATOR', // 技能生成器
  'SHOT_STATS', // 单次请求统计信息收集
  'SKILL_IMPROVEMENT', // 技能改进
  'SKILL_LEARNING', // 技能学习（已禁用）
  'SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED', // 禁用自动更新时跳过检测
  'SLOW_OPERATION_LOGGING', // 慢操作日志
  'SSH_REMOTE', // SSH 远程连接，本地 REPL + 远端工具执行
  'STREAMLINED_OUTPUT', // 精简输出模式
  'SUBAGENT_SUMMARY_GATE', // 子代理摘要质量门（最终文本过短时追加一轮扩写）
  'TEMPLATES', // 模板任务（new/list/reply 子命令）
  'TERMINAL_PANEL', // 终端面板
  'TOKEN_BUDGET', // Token 预算管理与控制
  'TOOL_LOOP_DETECTION', // 工具调用死循环分级干预（连击检测 + reminder 注入）
  'TORCH', // Torch 模式
  'TRANSCRIPT_CLASSIFIER', // 对话分类器，用于标注会话类型
  'TREE_SITTER_BASH', // tree-sitter Bash 解析
  'TREE_SITTER_BASH_SHADOW', // tree-sitter Bash 影子模式（对照验证）
  'ULTRAPLAN', // 超级规划模式，深度分析后生成实施计划
  'ULTRATHINK', // 超深度思考模式，增加推理链长度
  'UNATTENDED_RETRY', // 无人值守重试
  'UPLOAD_USER_SETTINGS', // 上传用户设置
  'VERIFICATION_AGENT', // 任务完成后的验证代理
  'VOICE_MODE', // Push-to-Talk 语音输入模式
  'WEB_BROWSER_TOOL', // Web 浏览器工具
  'WORKFLOW_SCRIPTS', // 工作流脚本（.claude/workflows/ 中的 YAML/MD）
] as const

/** Literal union of all registered feature flag names. */
export type FeatureFlagName = (typeof FEATURE_FLAGS)[number]
