/**
 * 官方 bundle 漂移比对 —— 每次官方版本升级后手动跑一次。
 *
 * 官方发行物是单个 30MB minified bundle，没有 upstream remote 可以 merge，
 * 唯一可靠的对照方式是 grep 里面的字符串常量。本脚本把四类"在 minified
 * 产物里仍然稳定可读"的常量各抽成一张清单，与 dev 树里的同类常量做集合差。
 *
 * 覆盖范围与已知盲区：
 *   - model ID / beta header —— 双向 diff，信号干净。
 *   - 工具 wire name —— 只做单向（dev 有、官方没有）。官方 bundle 里工具名
 *     经过模板插值（`${"ScheduleWakeup"}`）且 name getter 被 minify，无法可靠
 *     枚举出"官方有而 dev 没有"的工具。实践中新工具几乎总是伴随一个新的 beta
 *     header，由上面那类间接兜住。
 *
 * 不覆盖 gate 名（`tengu_*`）：官方有 1700+ 个，其中绝大多数是与本 fork 无关
 * 的内部代号（tengu_amber_lark 之类），而且本地 gate 已硬关，列出来只会把
 * 真正有信号的两栏淹掉。需要时直接 grep bundle。
 *
 * 用法：
 *   bun run check:drift
 *   bun scripts/check-upstream-drift.ts --bundle=/path/to/cli.js
 *   CLAUDE_OFFICIAL_BUNDLE=/path/to/cli.js bun run check:drift
 *
 * 这是报告工具，不是棘轮 —— 漂移是常态，不进 precheck。
 */
import { Glob } from 'bun'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULT_BUNDLE =
  '/Volumes/work/software/install/claude-official/modules/src/entrypoints/cli.js'

/** 在 minified 产物里仍然稳定可读的常量族。 */
const CATEGORIES = [
  {
    name: 'model ID',
    pattern: /claude-(?:opus|sonnet|haiku|fable)-[0-9a-z]+(?:-[0-9a-z]+)*/g,
  },
  {
    name: 'beta header',
    pattern: /[a-z][a-z0-9]*(?:-[a-z0-9]+)*-20\d\d-\d\d-\d\d/g,
  },
] as const

/** dev 侧工具 wire name 的声明形式：`export const X_TOOL_NAME = 'Wire'`。 */
const TOOL_NAME_PATTERN =
  /export const [A-Z_0-9]*TOOL_NAME[A-Z_0-9]* = '([^']+)'/g

/** 每类最多打印多少条，超出只报数量。 */
const MAX_SHOWN = 40

export function extractSet(text: string, pattern: RegExp): Set<string> {
  // 全局正则带 lastIndex 状态，复用前必须重置。
  pattern.lastIndex = 0
  const out = new Set<string>()
  for (const m of text.matchAll(pattern)) out.add(m[1] ?? m[0])
  return out
}

export function diffSets(
  official: Set<string>,
  dev: Set<string>,
): { onlyOfficial: string[]; onlyDev: string[] } {
  return {
    onlyOfficial: [...official].filter(v => !dev.has(v)).sort(),
    onlyDev: [...dev].filter(v => !official.has(v)).sort(),
  }
}

/**
 * dev 侧源码全文。跳过测试文件 —— 测试里有大量捏造的 model ID
 * （`claude-opus-4-50`、`...-20240101`），会把 onlyDev 这一栏淹掉。
 */
async function readDevSources(): Promise<string> {
  const glob = new Glob('{src,packages}/**/*.{ts,tsx}')
  const chunks: string[] = []
  for await (const rel of glob.scan(ROOT)) {
    if (
      rel.includes('node_modules') ||
      rel.includes('/dist/') ||
      rel.includes('__tests__') ||
      rel.endsWith('.test.ts') ||
      rel.endsWith('.test.tsx')
    ) {
      continue
    }
    chunks.push(await Bun.file(resolve(ROOT, rel)).text())
  }
  return chunks.join('\n')
}

function report(label: string, values: string[]): void {
  if (values.length === 0) {
    console.log(`  ${label}: —`)
    return
  }
  const shown = values.slice(0, MAX_SHOWN)
  console.log(`  ${label} (${values.length}):`)
  for (const v of shown) console.log(`    ${v}`)
  if (values.length > shown.length) {
    console.log(`    … 另有 ${values.length - shown.length} 条`)
  }
}

async function main(): Promise<void> {
  const fromArg = process.argv
    .find(a => a.startsWith('--bundle='))
    ?.slice('--bundle='.length)
  const bundlePath =
    fromArg ?? process.env.CLAUDE_OFFICIAL_BUNDLE ?? DEFAULT_BUNDLE

  if (!existsSync(bundlePath)) {
    console.error(`找不到官方 bundle: ${bundlePath}`)
    console.error('用 --bundle=<path> 或 CLAUDE_OFFICIAL_BUNDLE 指定。')
    process.exit(1)
  }

  const [official, dev] = await Promise.all([
    Bun.file(bundlePath).text(),
    readDevSources(),
  ])

  console.log(
    `官方 bundle: ${bundlePath} (${(official.length / 1e6).toFixed(1)}MB)`,
  )
  console.log('')

  for (const { name, pattern } of CATEGORIES) {
    const { onlyOfficial, onlyDev } = diffSets(
      extractSet(official, pattern),
      extractSet(dev, pattern),
    )
    console.log(`## ${name}`)
    report('官方有 / dev 没有', onlyOfficial)
    report('dev 有 / 官方没有', onlyDev)
    console.log('')
  }

  const devTools = extractSet(dev, TOOL_NAME_PATTERN)
  const devOnlyTools = [...devTools]
    .filter(t => !official.includes(`"${t}"`) && !official.includes(`'${t}'`))
    .sort()
  console.log('## 工具 wire name（单向：官方 bundle 里无法可靠枚举，见文件头）')
  report('dev 有 / 官方没有', devOnlyTools)
}

if (import.meta.main) await main()
