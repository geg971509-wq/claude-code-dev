import { describe, expect, test } from 'bun:test'
import { isForwardSubagentTextEnabled } from '../print.js'

describe('isForwardSubagentTextEnabled', () => {
  test('enables forwarding only for stream-json output', () => {
    expect(isForwardSubagentTextEnabled('stream-json', true)).toBe(true)
    expect(isForwardSubagentTextEnabled('json', true)).toBe(false)
    expect(isForwardSubagentTextEnabled('text', true)).toBe(false)
    expect(isForwardSubagentTextEnabled(undefined, true)).toBe(false)
  })

  test('preserves disabled behavior for false or omitted flags', () => {
    expect(isForwardSubagentTextEnabled('stream-json', false)).toBe(false)
    expect(isForwardSubagentTextEnabled('stream-json', undefined)).toBe(false)
  })
})
