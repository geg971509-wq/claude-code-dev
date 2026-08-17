/**
 * dump-prompt.ts — 导出完整 system prompt，用于人工检查格式与内容。
 *
 *   bun run scripts/dump-prompt.ts                     # 默认机型，写入文件
 *   bun run scripts/dump-prompt.ts claude-sonnet-4-6   # 指定机型
 *   bun run scripts/dump-prompt.ts --stdout            # 打到 stdout，不落盘
 *
 * 这个脚本此前是一堵 30+ 条局部 `mock.module` 的墙，每条用 1~3 个导出替换掉
 * 整个真实模块。后果是它在两个不同的时间点静默损坏过（先是 model.js 的 mock
 * 缺 `getMainLoopModel`，后是 settings.js 的 mock 缺 `updateSettingsForSource`）
 * —— 导入图里任何一处新增的兄弟导出都会把它炸掉，而没有任何东西在守它。
 *
 * 实测 `getSystemPrompt` 只需要一个 `globalThis.MACRO`（构建期 define，脚本
 * 直接跑时不存在）就能跑通，所以整堵墙删掉了。副作用是导出的是**当前项目的
 * 真实 prompt**（真实 cwd / git 状态 / CLAUDE.md），这对"人工检查内容"反而
 * 更有价值 —— 看到的就是模型真正收到的东西。
 */

// MACRO 是构建期注入的 define（见 scripts/defines.ts）。脚本不经过 bun -d，
// 必须在导入任何读取它的模块之前把它放上去。
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '0.0.0-dump',
  BUILD_TIME: '1970-01-01T00:00:00Z',
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: 'report issues on GitHub',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: '',
  VERSION_CHANGELOG: '',
}

// CLI 启动时会调 enableConfigs() 放开配置读取；不调的话 getGlobalConfig()
// 会抛 "Config accessed before allowed."。走这个正规入口，而不是伪造
// NODE_ENV=test 去命中守卫的豁免分支。
const { enableConfigs } = await import('src/utils/config.js')
enableConfigs()

const { getSystemPrompt } = await import('src/constants/prompts.js')

/** 主循环常见的核心工具，够触发绝大多数按工具分支的段落。 */
const TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Agent',
  'AskUserQuestion',
  'TaskCreate',
].map(name => ({ name }))

export async function dumpSystemPrompt(model: string): Promise<string> {
  const sections = await getSystemPrompt(TOOLS as never, model)
  return sections.join('\n\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const toStdout = args.includes('--stdout')
  const model = args.find(a => !a.startsWith('--')) ?? 'claude-opus-4-7'
  const full = await dumpSystemPrompt(model)
  if (toStdout) {
    // 守卫测试用这条路径：不落盘就不会弄脏工作区。
    process.stdout.write(full)
  } else {
    const outputPath = 'scripts/system-prompt-dump.txt'
    await Bun.write(outputPath, full)
    console.log(`model: ${model}`)
    console.log(`written: ${outputPath}`)
    console.log(`chars: ${full.length} | lines: ${full.split('\n').length}`)
  }
}
