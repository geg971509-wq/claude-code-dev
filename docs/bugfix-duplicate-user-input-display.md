# Bugfix: 用户输入在终端显示两次

## 问题描述

在 Windows 平台（可能也影响其他平台）上，用户输入一次 prompt 后，在终端 console 中会显示两次相同的内容。

**复现场景：**
- 用户输入："目前收益最好的是什么情况？400字以内回复"
- 终端显示：该文本显示了两次

**影响范围：**
- 主要在 Windows 编译版本中观察到
- 使用 Claude 模型时出现
- 不影响功能，但用户体验差

## 根本原因

问题源于 React 状态更新的时序问题，涉及两个独立的 state：

1. **`userInputOnProcessing`** - placeholder 文本，用于在用户提交后、实际消息添加到列表前显示临时输入
2. **`messages`** - 实际的消息列表

### 问题流程：

```
用户提交 input
  ↓
setUserInputOnProcessing(input)  // Line 4119: 设置 placeholder
  ↓
[React 可能在此处渲染一帧]
  ↓
onQuery() 被调用
  ↓
setMessages([...oldMessages, ...newMessages])  // Line 3580: 添加真实消息
  ↓
[React 渲染]
```

在某些情况下，React 会在 `setUserInputOnProcessing` 和 `setMessages` 之间渲染一帧，此时：
- `userInputOnProcessing` 有值 → placeholder 显示用户输入
- `displayedMessages.length <= userInputBaselineRef.current` → 条件满足
- **结果：placeholder 显示了用户输入**

然后 `setMessages` 更新后：
- 实际的用户消息也被渲染
- **最终结果：用户输入显示了两次**

### 关键代码位置：

**设置 placeholder (REPL.tsx:4118-4119):**
```typescript
if (!isSlashCommand && inputMode === 'prompt' && !speculationAccept && !activeRemote.isRemoteMode) {
  setUserInputOnProcessing(input);  // 设置 placeholder
  resetTimingRefs();
}
```

**添加实际消息 (REPL.tsx:3580):**
```typescript
setMessages(oldMessages => [...oldMessages, ...newMessages]);  // 添加真实用户消息
```

**Placeholder 显示条件 (REPL.tsx:5574-5577):**
```typescript
const placeholderText =
  userInputOnProcessing && !viewedAgentTask && displayedMessages.length <= userInputBaselineRef.current
    ? userInputOnProcessing
    : undefined;
```

## 修复方案

在 `setMessages` 调用**之前**立即清除 `userInputOnProcessing`，确保 placeholder 在真实消息添加前被移除。

**修改位置：** `src/screens/REPL.tsx:3580`

**修改前：**
```typescript
try {
  setWasAborted(false);
  resetTimingRefs();
  setMessages(oldMessages => [...oldMessages, ...newMessages]);
  responseLengthRef.current = 0;
  // ...
}
```

**修改后：**
```typescript
try {
  setWasAborted(false);
  resetTimingRefs();
  // Clear the placeholder immediately before adding the real user message
  // to prevent displaying the input twice (placeholder + actual message)
  // in the same frame. The placeholder's purpose is to bridge the gap
  // between submission and setMessages — once setMessages fires, it's done.
  setUserInputOnProcessing(undefined);
  setMessages(oldMessages => [...oldMessages, ...newMessages]);
  responseLengthRef.current = 0;
  // ...
}
```

## 验证

修复后运行完整的预检查：

```bash
bun run precheck
```

结果：
- ✅ TypeScript 类型检查通过
- ✅ Biome lint 检查通过（3394 文件，无问题）
- ✅ 依赖边界检查通过（3 个反向导入，符合 baseline）
- ✅ 测试通过（6670 pass, 10 skip, 0 fail）

## 设计说明

### Placeholder 的设计意图

`userInputOnProcessing` 是一个 **瞬态 placeholder**，设计用途是：
- 在用户按下 Enter 后立即提供视觉反馈
- 桥接从输入提交到 `setMessages` 调用之间的时间间隙
- 一旦真实消息添加到 `messages` 列表，placeholder 就应该消失

### 清理时机

原有的清理逻辑在 `resetLoadingState()` 中（Line 1866），但该函数在查询**完成后**才调用，远晚于 `setMessages`。这导致了 placeholder 和真实消息共存的窗口期。

新的清理逻辑在 `setMessages` **之前**立即执行，确保：
1. Placeholder 在同一个 React 批处理中被清除
2. 真实消息添加时，placeholder 已经不存在
3. 不会出现两者同时显示的情况

## 相关文件

- `src/screens/REPL.tsx` - 主修复文件
- `src/components/PromptInput/PromptInput.tsx` - 用户输入组件
- `src/utils/handlePromptSubmit.ts` - 输入处理逻辑
- `src/utils/processUserInput/processUserInput.ts` - 用户输入处理
- `src/utils/processUserInput/processTextPrompt.ts` - 文本 prompt 处理

## 测试建议

1. **手动测试：**
   - 在 Windows 上编译并运行
   - 输入各种长度的 prompt
   - 验证只显示一次用户输入

2. **自动化测试：**
   - 现有的 6670 个测试已覆盖基本功能
   - 考虑添加针对 placeholder 显示/隐藏时序的单元测试

3. **回归测试：**
   - 验证 placeholder 在正常情况下仍然工作
   - 验证在 slash 命令、bash 模式、speculation 等场景下行为正确

## 补充说明

### 为什么不在其他地方修复？

1. **不在设置时修复** - `setUserInputOnProcessing(input)` 的时机是正确的，需要立即提供视觉反馈
2. **不在渲染层修复** - 条件判断 `displayedMessages.length <= userInputBaselineRef.current` 也是正确的
3. **在 state 更新时修复** - 在添加真实消息前清除 placeholder 是最直接、最可靠的方案

### React 批处理说明

虽然 React 18+ 有自动批处理功能，但跨 `async` 边界的多个 state 更新不能保证在同一批次中执行。`setUserInputOnProcessing` 和 `setMessages` 在不同的执行上下文中，因此需要显式同步。

## 影响评估

**风险等级：** 低

**影响范围：**
- 仅影响用户输入的显示逻辑
- 不影响消息处理、API 调用、工具执行等核心功能
- placeholder 机制的其他用途（spinner 显示等）不受影响

**兼容性：**
- 向后兼容
- 不影响现有功能
- 不需要数据迁移
