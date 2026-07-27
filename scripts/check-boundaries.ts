/**
 * Dependency boundary ratchet — 遏制 packages/ → src/ 的反向依赖。
 *
 * 借鉴 kimi-code 的层级边界纪律（packages 永不反向依赖 app）。存量违规无法
 * 一次性清除，因此采用棘轮（ratchet）策略：只减不增。
 *
 * 棘轮**按包**计数，不是按总数。总数棘轮在存量高度集中于一个包时是空转的：
 * 其他包新增越界导入，可以靠存量包删掉同样多条来抵消，总数不变而方向性退化
 * 已经发生。按包计数让每个包各自封顶，一个包的清理不能为另一个包买单。
 *
 * 新包的基线天然是 0 —— 基线里没有的包按 0 处理，所以新增越界导入立刻失败，
 * 不需要先注册。
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
/** Matches relative imports that walk upward at least once — for resolved path check. */
const REL_UP_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.\.\/[^'"]*)['"]/g

const EXCLUDED_SEGMENTS = ['/node_modules/', '/dist/', '/build/', '/.turbo/']

async function countReverseImports(): Promise<Map<string, number>> {
  const appSrc = resolve(repoRoot, 'src')
  const glob = new Glob('packages/**/*.{ts,tsx}')
  const perFile = new Map<string, number>()
  for await (const file of glob.scan({ cwd: repoRoot })) {
    const normalized = `/${file}`
    if (EXCLUDED_SEGMENTS.some(seg => normalized.includes(seg))) continue
    const abs = resolve(repoRoot, file)
    const content = readFileSync(abs, 'utf-8')

    // Literal 'src/' imports
    let count = content.match(REVERSE_IMPORT_RE)?.length ?? 0

    // Relative imports that resolve into src/ — invisible to the literal regex
    for (const m of content.matchAll(REL_UP_IMPORT_RE)) {
      const spec = m[1]!
      const resolved = resolve(dirname(abs), spec)
      if (resolved === appSrc || resolved.startsWith(`${appSrc}/`)) {
        count++
      }
    }

    if (count > 0) {
      perFile.set(file, count)
    }
  }
  return perFile
}

/**
 * Owning package for a file under packages/, honoring one level of npm scope
 * (`packages/@ant/ink/...` → `@ant/ink`). Files directly under packages/ have no
 * owning package and are reported under `<root>` so they cannot slip through
 * unattributed.
 */
function packageOf(file: string): string {
  const parts = file.split('/')
  // parts[0] === 'packages'
  if (parts.length < 3) return '<root>'
  return parts[1]!.startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1]!
}

function aggregateByPackage(perFile: Map<string, number>): Map<string, number> {
  const perPackage = new Map<string, number>()
  for (const [file, count] of perFile) {
    const pkg = packageOf(file)
    perPackage.set(pkg, (perPackage.get(pkg) ?? 0) + count)
  }
  return perPackage
}

type Baseline = {
  /** Per-package caps. A package absent from this map is capped at 0. */
  perPackage: Record<string, number>
}

function readBaseline(): Baseline | 'legacy' | null {
  if (!existsSync(baselinePath)) return null
  const data = JSON.parse(readFileSync(baselinePath, 'utf-8')) as {
    packagesToSrcImports?: number
    perPackage?: Record<string, number>
  }
  if (data.perPackage && typeof data.perPackage === 'object') {
    return { perPackage: data.perPackage }
  }
  // Pre-per-package baseline. Refuse to fall back to the total — that is the
  // check this replaced — and ask for an explicit one-time migration instead.
  if (typeof data.packagesToSrcImports === 'number') return 'legacy'
  return null
}

function writeBaseline(perPackage: Map<string, number>): void {
  // Sorted so the file diffs cleanly as packages are decoupled.
  const sorted = Object.fromEntries(
    [...perPackage.entries()].sort(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ perPackage: sorted }, null, 2)}\n`,
  )
}

/** Worst offending files inside one package, for the failure message. */
function topFilesFor(
  perFile: Map<string, number>,
  pkg: string,
  limit = 5,
): string {
  return [...perFile.entries()]
    .filter(([file]) => packageOf(file) === pkg)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([f, n]) => `      ${n}\t${f}`)
    .join('\n')
}

async function main() {
  const update = process.argv.includes('--update')
  const perFile = await countReverseImports()
  const perPackage = aggregateByPackage(perFile)
  const total = [...perPackage.values()].reduce((a, b) => a + b, 0)

  if (update) {
    writeBaseline(perPackage)
    console.log(
      `[boundaries] baseline updated: ${total} reverse imports across ` +
        `${perPackage.size} package(s)`,
    )
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
  if (baseline === 'legacy') {
    console.error(
      `[boundaries] baseline ${baselinePath} still uses the old total-only ` +
        `format.\n` +
        `  The ratchet is now per-package, because a single total lets one ` +
        `package's\n` +
        `  cleanup pay for another package's new violations.\n` +
        `  Migrate once: bun scripts/check-boundaries.ts --update`,
    )
    process.exit(1)
  }

  // Every package present now or in the baseline, so a package that reached zero
  // is still reported as a tightening opportunity.
  const allPackages = new Set([
    ...perPackage.keys(),
    ...Object.keys(baseline.perPackage),
  ])

  const regressions: string[] = []
  const improvements: string[] = []
  for (const pkg of [...allPackages].sort()) {
    const current = perPackage.get(pkg) ?? 0
    const cap = baseline.perPackage[pkg] ?? 0
    if (current > cap) {
      regressions.push(
        `    ${pkg}: ${current} > ${cap} (+${current - cap})\n` +
          `${topFilesFor(perFile, pkg)}`,
      )
    } else if (current < cap) {
      improvements.push(`    ${pkg}: ${current} < ${cap} (-${cap - current})`)
    }
  }

  if (regressions.length > 0) {
    console.error(
      `[boundaries] FAIL: packages/ → src/ reverse imports increased in ` +
        `${regressions.length} package(s).\n` +
        `  packages/ 内禁止新增对主应用 src/ 的导入（层级边界棘轮，按包只减不增）。\n` +
        `  请改为：把共享逻辑下沉到 workspace 包，或通过参数/注入传入。\n` +
        `${regressions.join('\n')}`,
    )
    process.exit(1)
  }

  if (improvements.length > 0) {
    console.log(
      `[boundaries] OK: ${total} reverse imports total.\n` +
        `  已减少 — 请收紧基线并提交：bun scripts/check-boundaries.ts --update\n` +
        `${improvements.join('\n')}`,
    )
    return
  }

  console.log(
    `[boundaries] OK: ${total} reverse imports across ${perPackage.size} ` +
      `package(s) (== baseline)`,
  )
}

await main()
