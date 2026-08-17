import { describe, expect, test } from 'bun:test'
import {
  diffSets,
  extractSet,
  parseOfficialModelTable,
} from '../check-upstream-drift.js'

describe('extractSet', () => {
  test('collects every match, deduplicated', () => {
    const re = /claude-(?:opus|sonnet)-[0-9a-z]+(?:-[0-9a-z]+)*/g
    expect(
      extractSet('a claude-opus-4-7 b claude-opus-4-7 c claude-sonnet-5', re),
    ).toEqual(new Set(['claude-opus-4-7', 'claude-sonnet-5']))
  })

  test('is reusable — a global regex keeps lastIndex between calls', () => {
    const re = /tengu_[a-z0-9_]+/g
    expect(extractSet('tengu_alpha', re)).toEqual(new Set(['tengu_alpha']))
    // Without the lastIndex reset this second call would silently return empty.
    expect(extractSet('tengu_alpha', re)).toEqual(new Set(['tengu_alpha']))
  })

  test('prefers capture group 1 when the pattern has one', () => {
    const re = /export const [A-Z_]*TOOL_NAME = '([^']+)'/g
    expect(extractSet("export const FILE_READ_TOOL_NAME = 'Read'", re)).toEqual(
      new Set(['Read']),
    )
  })
})

describe('diffSets', () => {
  test('splits both directions and sorts', () => {
    expect(
      diffSets(new Set(['b', 'a', 'shared']), new Set(['shared', 'z'])),
    ).toEqual({
      onlyOfficial: ['a', 'b'],
      onlyDev: ['z'],
    })
  })
})

describe('parseOfficialModelTable', () => {
  // 这个解析器两次栽在「正则跨结构取值」上：先是 provider_ids 里的 null 让
  // /bedrock: "([^"]+)"/ 抓到相邻机型的值，后是 context 里嵌套的
  // native_1m_3p 让 \{([^}]*)\} 截断、吞掉排在它之后的 supports_1m_beta。
  // 两次的失效方式都是**静默报平安**，比它监控的任何字段都危险。
  const FRAGMENT = `
    id: "claude-fake-1",
    family: "fake",
    provider_ids: { first_party: "claude-fake-1", bedrock: null, vertex: "vx-fake-1" },
    context: { window: 1000000, native_1m: true, native_1m_3p: { bedrock: true }, supports_1m_beta: true },
    max_output_tokens: { default: 64000, upper: 128000 },
    pricing: "tier_5_25",
    capabilities: ["effort"]
  `

  test('取得到嵌套对象之后的字段', () => {
    const [model] = parseOfficialModelTable(FRAGMENT)
    expect(model?.native1m).toBe(true)
    // 截断的解析器会把这个漏成 false —— 正是 sonnet-5 被录错的那一格。
    expect(model?.supports1mBeta).toBe(true)
  })

  test('provider 为 null 时不串到别的字段', () => {
    const [model] = parseOfficialModelTable(FRAGMENT)
    expect(model?.firstParty).toBe('claude-fake-1')
    expect(model?.vertex).toBe('vx-fake-1')
    // bedrock 是 null，必须是缺省而不是隔壁的值。
    expect(model?.bedrock).toBeUndefined()
  })
})
