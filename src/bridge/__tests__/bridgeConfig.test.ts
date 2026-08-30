import { afterEach, describe, expect, test } from 'bun:test'
import { getBridgeSessionNamePrefix } from '../bridgeConfig.js'

const previousPrefix =
  process.env.CLAUDE_CODE_REMOTE_CONTROL_SESSION_NAME_PREFIX

afterEach(() => {
  if (previousPrefix === undefined) {
    delete process.env.CLAUDE_CODE_REMOTE_CONTROL_SESSION_NAME_PREFIX
  } else {
    process.env.CLAUDE_CODE_REMOTE_CONTROL_SESSION_NAME_PREFIX = previousPrefix
  }
})

describe('getBridgeSessionNamePrefix', () => {
  test('trims a configured prefix', () => {
    process.env.CLAUDE_CODE_REMOTE_CONTROL_SESSION_NAME_PREFIX = '  work  '
    expect(getBridgeSessionNamePrefix()).toBe('work')
  })

  test('ignores an empty prefix', () => {
    process.env.CLAUDE_CODE_REMOTE_CONTROL_SESSION_NAME_PREFIX = '   '
    expect(getBridgeSessionNamePrefix()).toBeUndefined()
  })
})
