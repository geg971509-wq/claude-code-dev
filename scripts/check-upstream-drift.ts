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
 * 已知未覆盖的官方字段（刻意不补）：`fallback_3p`（逐模型 3P 降级链）、
 * `eager_input_streaming`、`vertex_region_env_var`、`advisor_rank`。这几个在
 * 官方 bundle 里全部只出现在数据行与 zod schema 中，查不到任何消费点 ——
 * 官方自己都没用，录进 dev 只会是无人读取的死数据。
 *
 * 这是报告工具，不是棘轮 —— 漂移是常态，不进 precheck。
 */
import { Glob } from 'bun'
import { MODEL_CATALOG } from '../src/utils/model/configs.js'
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

/**
 * 官方 bundle 里的模型注册表是一个**未被 minify 的对象字面量数组**（标识符
 * 被压缩了，对象键没有），所以可以逐字段解析出来与 MODEL_CATALOG 对账。
 *
 * 这一栏存在的理由：字符串集合差只能发现"官方有某个 ID 而 dev 没有"，发现
 * 不了"两边都有这个模型、但窗口/输出上限/定价/能力写错了"。连续两轮的真实
 * 缺陷全属于后者（sonnet-4-5 的 1M 被当成原生、opus-4-8 的输出 default 掉进
 * 32k 分支），字符串栏一条都没报出来。
 */
type OfficialModel = {
  id: string
  window: number | undefined
  native1m: boolean
  supports1mBeta: boolean
  outDefault: number | undefined
  outUpper: number | undefined
  pricing: string | undefined
  capabilities: string[]
  knowledgeCutoff: string | undefined
  defaultEffort: string | undefined
  firstParty: string | undefined
  bedrock: string | undefined
  vertex: string | undefined
}

/** 官方 id → dev canonical。官方用 `-4-0`，dev 用不带 `-0` 的形式。 */
const OFFICIAL_ID_TO_CANONICAL: Record<string, string> = {
  'claude-opus-4-0': 'claude-opus-4',
  'claude-sonnet-4-0': 'claude-sonnet-4',
}

/**
 * 按大括号配对取出 `key: { ... }` 整块 —— 官方的 `context` 里嵌着
 * `native_1m_3p: { bedrock, vertex, foundry }`，用 `\{([^}]*)\}` 会在嵌套
 * 对象的第一个 `}` 处截断，把排在它**之后**的字段（sonnet-5 的
 * `supports_1m_beta`）整个吞掉，于是对账器拿着残缺的"官方值"与 dev 比对、
 * 报告一切正常。同一个文件里第二次栽在"正则跨结构取值"上了。
 */
function extractBlock(seg: string, key: string): string {
  const at = seg.indexOf(`${key}: {`)
  if (at < 0) return ''
  let depth = 0
  const open = seg.indexOf('{', at)
  for (let i = open; i < seg.length; i++) {
    if (seg[i] === '{') depth++
    else if (seg[i] === '}') depth--
    if (depth === 0) return seg.slice(open, i + 1)
  }
  return ''
}

/**
 * 只在 `provider_ids: { ... }` 这一段内取值，且把 `null` 当作缺省。
 *
 * 早先是直接在整段 3000 字符窗口里 `/bedrock: "([^"]+)"/` —— 一旦某个机型的
 * provider 是 null（mythos-5 除 first_party 外全 null），正则会跳过它、抓到
 * **相邻机型**的值，于是对账器报出根本不存在的"官方值"。工具编造事实比没有
 * 工具更坏，所以这里按块解析。
 */
function parseProviderIds(seg: string): {
  firstParty: string | undefined
  bedrock: string | undefined
  vertex: string | undefined
} {
  const block = extractBlock(seg, 'provider_ids')
  const pick = (field: string): string | undefined =>
    new RegExp(`\\b${field}: "([^"]+)"`).exec(block)?.[1]
  return {
    firstParty: pick('first_party'),
    bedrock: pick('bedrock'),
    vertex: pick('vertex'),
  }
}

export function parseOfficialModelTable(bundle: string): OfficialModel[] {
  const out: OfficialModel[] = []
  for (const m of bundle.matchAll(
    /id: "(claude-[a-z0-9-]+)",\s*\n?\s*family:/g,
  )) {
    const seg = bundle.slice(m.index, m.index + 3000).replace(/\s+/g, ' ')
    const ctx = extractBlock(seg, 'context')
    const out2 = /max_output_tokens: \{ default: (\d+), upper: (\d+) \}/.exec(
      seg,
    )
    const caps = /capabilities: \[([^\]]*)\]/.exec(seg)?.[1] ?? ''
    out.push({
      id: m[1]!,
      window: Number(/window: (\d+)/.exec(ctx)?.[1]) || undefined,
      native1m: ctx.includes('native_1m: true'),
      supports1mBeta: ctx.includes('supports_1m_beta: true'),
      outDefault: out2 ? Number(out2[1]) : undefined,
      outUpper: out2 ? Number(out2[2]) : undefined,
      pricing: /pricing: "([^"]+)"/.exec(seg)?.[1],
      knowledgeCutoff: /knowledge_cutoff: "([^"]+)"/.exec(seg)?.[1],
      defaultEffort: /default_effort: "([a-z]+)"/.exec(seg)?.[1],
      ...parseProviderIds(seg),
      capabilities: caps
        .split(',')
        .map(c => c.trim().replace(/^"|"$/g, ''))
        .filter(Boolean),
    })
  }
  return out
}

function reconcileModelTable(bundle: string): void {
  const official = parseOfficialModelTable(bundle)
  console.log('## 模型表逐字段对账')
  if (official.length === 0) {
    console.log('  官方表未能解析 —— bundle 结构可能已变，需要更新解析规则。')
    return
  }
  const byCanonical = new Map(MODEL_CATALOG.map(e => [e.canonical, e]))
  const problems: string[] = []
  for (const o of official) {
    const canonical = OFFICIAL_ID_TO_CANONICAL[o.id] ?? o.id
    const dev = byCanonical.get(canonical)
    if (!dev) {
      problems.push(`${o.id}: catalog 里没有这个模型`)
      continue
    }
    const cmp: [string, unknown, unknown][] = [
      ['context.window', o.window, dev.context.window],
      ['context.native_1m', o.native1m, dev.context.native1m],
      [
        'context.supports_1m_beta',
        o.supports1mBeta,
        dev.context.supports1mBeta,
      ],
      ['max_output_tokens.default', o.outDefault, dev.maxOutputTokens.default],
      ['max_output_tokens.upper', o.outUpper, dev.maxOutputTokens.upper],
      ['pricing', o.pricing, dev.pricing],
      ['knowledge_cutoff', o.knowledgeCutoff, dev.knowledgeCutoff],
      ['default_effort', o.defaultEffort, dev.defaultEffort],
      ['provider_ids.first_party', o.firstParty, dev.providerIds?.firstParty],
      ['provider_ids.bedrock', o.bedrock, dev.providerIds?.bedrock],
      ['provider_ids.vertex', o.vertex, dev.providerIds?.vertex],
      [
        'capabilities',
        [...o.capabilities].sort().join(','),
        [...dev.capabilities].sort().join(','),
      ],
    ]
    for (const [field, want, got] of cmp) {
      if (want !== undefined && want !== got) {
        problems.push(
          `${canonical}.${field}: 官方 ${String(want)} / dev ${String(got)}`,
        )
      }
    }
  }
  report('字段不一致', problems)
}

/**
 * 命名对照：官方 bundle 里约 2500 个函数名逃过了 minify（例如
 * `getPublicModelDisplayName`、`parseUserSpecifiedModel`）。dev 是 decompile
 * 产物，不少函数是当初重起的名字。
 *
 * 这里**不做**自动配对。试过按 camelCase 词元做近似匹配，实测信噪比不可用：
 * 共享 ≥2 词元出 1777 条、≥3 出 72 条、≥4 出 8 条而其中仍多为误配
 * （`getPlanModeV2ExploreAgentCount` ?→ `getPlanModeAttachmentTurnCount` 是
 * 两回事）。真正找到的那对 —— dev 的 `getMarketingNameForModel` 对应官方的
 * `getPublicModelDisplayName` —— 是靠读官方函数体认出来的，名字相似度帮不上。
 *
 * 所以只保留两件有信号的事：同名数量（对齐度的粗略体温计），以及按概念
 * 检索官方函数名（`--names <片段>`），后者正是人工认名时真正在做的动作。
 */
function reconcileNames(bundle: string, dev: string, query?: string): void {
  const official = extractSet(bundle, /function ([a-z][A-Za-z0-9_]{7,})\(/g)
  const devNames = extractSet(
    dev,
    /export (?:async )?function ([a-zA-Z][A-Za-z0-9_]{7,})\(/g,
  )
  const shared = [...devNames].filter(n => official.has(n))

  console.log('## 命名对照')
  console.log(
    `  官方可读函数名 ${official.size} · dev 导出函数名 ${devNames.size} · 同名 ${shared.length}`,
  )
  if (!query) {
    console.log('  用 --names <片段> 按概念检索官方函数名。')
    return
  }
  const needle = query.toLowerCase()
  const hits = [...official]
    .filter(n => n.toLowerCase().includes(needle))
    .sort()
  report(`官方含 "${query}" 的函数名`, hits)
  const devHits = [...devNames]
    .filter(n => n.toLowerCase().includes(needle))
    .sort()
  report(`dev 含 "${query}" 的导出函数名`, devHits)
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

  reconcileModelTable(official)
  console.log('')

  reconcileNames(
    official,
    dev,
    process.argv.find(a => a.startsWith('--names='))?.slice('--names='.length),
  )
  console.log('')

  const devTools = extractSet(dev, TOOL_NAME_PATTERN)
  const devOnlyTools = [...devTools]
    .filter(t => !official.includes(`"${t}"`) && !official.includes(`'${t}'`))
    .sort()
  console.log('## 工具 wire name（单向：官方 bundle 里无法可靠枚举，见文件头）')
  report('dev 有 / 官方没有', devOnlyTools)
}

if (import.meta.main) await main()
