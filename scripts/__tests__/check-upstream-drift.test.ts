import { describe, expect, test } from 'bun:test'
import { diffSets, extractSet } from '../check-upstream-drift.js'

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
