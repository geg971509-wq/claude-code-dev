// 与官方的已知分歧（刻意保留）：官方 bundle 里 `var ZE = "ToolSearch"`，
// 延迟工具是单一的 ToolSearch；dev 拆成 SearchExtraTools（发现）+
// ExecuteExtraTool（调用）两步，官方没有后者。线名会进入 prompt、权限规则
// 和历史 transcript，单独改名会让已有会话与用户配置失效，因此不动。
export const SEARCH_EXTRA_TOOLS_TOOL_NAME = 'SearchExtraTools'
