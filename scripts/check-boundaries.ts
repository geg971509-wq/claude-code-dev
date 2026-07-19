/**
 * Dependency boundary ratchet — 遏制 packages/ → src/ 的反向依赖。
 *
 * 借鉴 kimi-code 的层级边界纪律（packages 永不反向依赖 app）。当前存量
 * 违规无法一次性清除，因此采用棘轮（ratchet）策略：
 *
 *   - 统计 packages/ 内所有 `from 'src/...'` 形式的反向导入总数
 *   - 与 scripts/boundaries-baseline.json 中的基线对比
 *   - 数量增加 → 报错退出（禁止新增越界导入）
 *   - 数量减少 → 提示运行 --update 收紧基线
 *
 * 用法：
 *   bun scripts/check-boundaries.ts            # 检查（precheck / CI）
 *   bun scripts/check-boundaries.ts --update   # 解耦后收紧基线
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const baselinePath = resolve(__dirname, 'boundaries-baseline.json')

/** Matches static/dynamic imports and requires of the app's src/ tree. */
const REVERSE_IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]src\//g

const EXCLUDED_SEGMENTS = ['/node_modules/', '/dist/', '/build/', '/.turbo/']

async function countReverseImports(): Promise<Map<string, number>> {
  const glob = new Glob('packages/**/*.{ts,tsx}')
  const perFile = new Map<string, number>()
  for await (const file of glob.scan({ cwd: repoRoot })) {
    const normalized = `/${file}`
    if (EXCLUDED_SEGMENTS.some(seg => normalized.includes(seg))) continue
    const content = readFileSync(resolve(repoRoot, file), 'utf-8')
    const matches = content.match(REVERSE_IMPORT_RE)
    if (matches && matches.length > 0) {
      perFile.set(file, matches.length)
    }
  }
  return perFile
}

function readBaseline(): number | null {
  if (!existsSync(baselinePath)) return null
  const data = JSON.parse(readFileSync(baselinePath, 'utf-8')) as {
    packagesToSrcImports?: number
  }
  return typeof data.packagesToSrcImports === 'number'
    ? data.packagesToSrcImports
    : null
}

async function main() {
  const update = process.argv.includes('--update')
  const perFile = await countReverseImports()
  const total = [...perFile.values()].reduce((a, b) => a + b, 0)

  if (update) {
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ packagesToSrcImports: total }, null, 2)}\n`,
    )
    console.log(`[boundaries] baseline updated: ${total} reverse imports`)
    return
  }

  const baseline = readBaseline()
  if (baseline === null) {
    console.error(
      `[boundaries] missing baseline file ${baselinePath}.\n` +
        'Run: bun scripts/check-boundaries.ts --update',
    )
    process.exit(1)
  }

  if (total > baseline) {
    const top = [...perFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([f, n]) => `    ${n}\t${f}`)
      .join('\n')
    console.error(
      `[boundaries] FAIL: packages/ → src/ reverse imports increased: ` +
        `${total} > baseline ${baseline} (+${total - baseline}).\n` +
        `  packages/ 内禁止新增对主应用 src/ 的导入（层级边界棘轮，只减不增）。\n` +
        `  请改为：把共享逻辑下沉到 workspace 包，或通过参数/注入传入。\n` +
        `  Top offenders:\n${top}`,
    )
    process.exit(1)
  }

  if (total < baseline) {
    console.log(
      `[boundaries] OK: ${total} reverse imports (baseline ${baseline}).\n` +
        `  已减少 ${baseline - total} 处 — 请收紧基线并提交：\n` +
        '  bun scripts/check-boundaries.ts --update',
    )
    return
  }

  console.log(`[boundaries] OK: ${total} reverse imports (== baseline)`)
}

await main()
