/**
 * dump-prompt 的守卫。
 *
 * 存在理由：这个脚本在两个不同的时间点静默损坏过（mock 墙缺导出），两次都
 * 无人发现 —— 因为没有任何东西在跑它。它是「把 system prompt 导出来人工审查」
 * 的唯一通路，坏掉就等于失去了对 prompt 内容的可见性。
 *
 * 顺带守住两条内容不变式（见下方各自的注释）。
 */
import { describe, expect, test } from 'bun:test'
import { relative, resolve } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const SCRIPT_REL =
  './' +
  relative(PROJECT_ROOT, resolve(__dirname, '..', 'dump-prompt.ts')).replace(
    /\\/g,
    '/',
  )

/**
 * 子进程运行：脚本会 `enableConfigs()` 并加载整条 prompt 依赖链，在共享
 * 进程里跑会把这些副作用漏给其他测试文件。
 */
async function runDumper(): Promise<string> {
  const proc = Bun.spawn(['bun', SCRIPT_REL, '--stdout'], {
    cwd: PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // prompt 构建链会取一次鉴权信息，但从不发请求。给个占位值，免得这条
      // 守卫依赖开发者本机是否登录 —— 那样在 CI 上必然红。
      ANTHROPIC_API_KEY:
        process.env.ANTHROPIC_API_KEY ?? 'sk-dump-prompt-probe',
    },
  })
  const code = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  if (code !== 0) {
    throw new Error(
      `dump-prompt.ts 退出码 ${code}:\n${(stderr + '\n' + stdout).slice(-2000)}`,
    )
  }
  return stdout
}

describe('dump-prompt', () => {
  test('导得出一份完整 system prompt', async () => {
    const prompt = await runDumper()
    // 下界取得很松：只要求它没有退化成空串或几行残骸。真实值约 24k。
    expect(prompt.length).toBeGreaterThan(5_000)
    expect(prompt).toContain('Claude Code')
  }, 120_000)

  test('模型能力名不会泄漏进 prompt', async () => {
    // MODEL_CATALOG 逐字保留了官方的 capabilities 数组，其中包含
    // `refusal_fallback` 这类与模型行为相关的内部标记。它们只该被
    // `.includes()` 当布尔量读，绝不该被序列化进送给模型的文本。
    const prompt = await runDumper()
    for (const marker of [
      'refusal_fallback',
      'rejects_disabled_thinking',
      'fable_5_mitigations',
      'adaptive_thinking',
      'lean_prompt',
    ]) {
      expect(prompt).not.toContain(marker)
    }
  }, 120_000)

  test('不含诱导模型拒答的措辞', async () => {
    // 唯一允许出现 "refusal" 的地方是那句引导用户去 /issue 报 bug 的说明，
    // 它的方向相反（模型拒答时怎么报告），不是让模型拒答。
    const prompt = await runDumper()
    const offenders = prompt
      .split('\n')
      .filter(line =>
        /\b(refuse to|decline to|must not answer|will not (help|assist|answer)|你必须拒绝|不得回答)\b/i.test(
          line,
        ),
      )
    expect(offenders).toEqual([])
  }, 120_000)
})
