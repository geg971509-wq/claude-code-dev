// builtin-tools — All tool implementations for Claude Code
// This barrel file re-exports the main tool constants and utilities.
// For specific submodules, use deep imports: 'builtin-tools/tools/XTool/XTool.js'

// =============================================================================
// Main tool exports (used by src/tools.ts)
// =============================================================================

// Core tools
export { AgentTool } from './AgentTool/AgentTool.js'
export { AskUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js'
export { BashTool } from './BashTool/BashTool.js'
export { BriefTool } from './BriefTool/BriefTool.js'
export { ConfigTool } from './ConfigTool/ConfigTool.js'
export { EnterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js'
export { EnterWorktreeTool } from './EnterWorktreeTool/EnterWorktreeTool.js'
export { ExitPlanModeV2Tool } from './ExitPlanModeTool/ExitPlanModeV2Tool.js'
export { ExitWorktreeTool } from './ExitWorktreeTool/ExitWorktreeTool.js'
export { FileEditTool } from './FileEditTool/FileEditTool.js'
export { FileReadTool } from './FileReadTool/FileReadTool.js'
export { FileWriteTool } from './FileWriteTool/FileWriteTool.js'
export { GlobTool } from './GlobTool/GlobTool.js'
export { GoalTool } from './GoalTool/GoalTool.js'
export { GrepTool } from './GrepTool/GrepTool.js'
export { LSPTool } from './LSPTool/LSPTool.js'
export { ListMcpResourcesTool } from './ListMcpResourcesTool/ListMcpResourcesTool.js'
export { LocalMemoryRecallTool } from './LocalMemoryRecallTool/LocalMemoryRecallTool.js'
export { VaultHttpFetchTool } from './VaultHttpFetchTool/VaultHttpFetchTool.js'
export { ReadMcpResourceTool } from './ReadMcpResourceTool/ReadMcpResourceTool.js'
export { NotebookEditTool } from './NotebookEditTool/NotebookEditTool.js'
export { SkillTool } from './SkillTool/SkillTool.js'
export { TaskOutputTool } from './TaskOutputTool/TaskOutputTool.js'
export { TaskStopTool } from './TaskStopTool/TaskStopTool.js'
export { TodoWriteTool } from './TodoWriteTool/TodoWriteTool.js'
export { SearchExtraToolsTool } from './SearchExtraToolsTool/SearchExtraToolsTool.js'
export { TungstenTool } from './TungstenTool/TungstenTool.js'
export { WebFetchTool } from './WebFetchTool/WebFetchTool.js'
export { WebSearchTool } from './WebSearchTool/WebSearchTool.js'
export { TestingPermissionTool } from './testing/TestingPermissionTool.js'

// Feature-gated tools
export { OVERFLOW_TEST_TOOL_NAME } from './OverflowTestTool/OverflowTestTool.js'
export { MonitorTool } from './MonitorTool/MonitorTool.js'
export { PowerShellTool } from './PowerShellTool/PowerShellTool.js'
export { PushNotificationTool } from './PushNotificationTool/PushNotificationTool.js'
export { REPLTool } from './REPLTool/REPLTool.js'
export { ArtifactTool } from './ArtifactTool/ArtifactTool.js'
export { RemoteTriggerTool } from './RemoteTriggerTool/RemoteTriggerTool.js'
export { CronCreateTool } from './ScheduleCronTool/CronCreateTool.js'
export { CronDeleteTool } from './ScheduleCronTool/CronDeleteTool.js'
export { CronListTool } from './ScheduleCronTool/CronListTool.js'
export { SendMessageTool } from './SendMessageTool/SendMessageTool.js'
export { SendUserFileTool } from './SendUserFileTool/SendUserFileTool.js'
export { SleepTool } from './SleepTool/SleepTool.js'
export { SnipTool } from './SnipTool/SnipTool.js'
export { SubscribePRTool } from './SubscribePRTool/SubscribePRTool.js'
export { SuggestBackgroundPRTool } from './SuggestBackgroundPRTool/SuggestBackgroundPRTool.js'
export { TeamCreateTool } from './TeamCreateTool/TeamCreateTool.js'
export { TeamDeleteTool } from './TeamDeleteTool/TeamDeleteTool.js'
export { TerminalCaptureTool } from './TerminalCaptureTool/TerminalCaptureTool.js'
export { VerifyPlanExecutionTool } from './VerifyPlanExecutionTool/VerifyPlanExecutionTool.js'
export { WebBrowserTool } from './WebBrowserTool/WebBrowserTool.js'
// WorkflowTool 实现已迁移到 @claude-code-best/workflow-engine（独立包，端口适配）。
// 注意：本 commit 移除了 builtin-tools 的 WorkflowTool 值导出和 getWorkflowCommands。
// - WorkflowTool 工厂：改由 @claude-code-best/workflow-engine 的 createWorkflowTool 提供
// - getWorkflowCommands：已移除，功能迁至 src/workflow/namedWorkflowCommands.ts
// 第三方若从本包 import 这两个符号，需切换到新路径。
export {
  createWorkflowTool,
  WORKFLOW_TOOL_NAME,
  type WorkflowToolDescriptor,
} from '@claude-code-best/workflow-engine'

// Constants
export {
  SYNTHETIC_OUTPUT_TOOL_NAME,
  createSyntheticOutputTool,
} from './SyntheticOutputTool/SyntheticOutputTool.js'

// Shared utilities
export {
  tagMessagesWithToolUseID,
  getToolUseIDFromParentMessage,
} from './utils.js'
