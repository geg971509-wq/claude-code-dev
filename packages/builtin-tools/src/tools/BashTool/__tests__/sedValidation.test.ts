import { describe, expect, test } from 'bun:test'
import {
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from '../bashPermissions.js'
import { checkSedConstraints } from '../sedValidation.js'

const ctx = { mode: 'default' } as Parameters<typeof checkSedConstraints>[1]
const strip = (cmd: string) => stripSafeWrappers(stripAllLeadingEnvVars(cmd))

function behavior(command: string) {
  return checkSedConstraints({ command }, ctx, strip).behavior
}

describe('checkSedConstraints', () => {
  test.each([
    ["sed 's/a/b/w /tmp/pwned' file.txt", 'ask'],
    ["timeout 5 sed 's/a/b/w /tmp/pwned' file.txt", 'ask'],
    ["FOO=1 sed 's/a/b/w /tmp/pwned' file.txt", 'ask'],
    ["nice sed 's/a/b/w /tmp/pwned' file.txt", 'ask'],
    ["nohup sed 's/a/b/w /tmp/pwned' file.txt", 'ask'],
    ["/usr/bin/sed 's/a/b/w /tmp/pwned' file.txt", 'ask'],
    ["ls && timeout 5 sed 's/a/b/w /tmp/pwned' file.txt", 'ask'],
    ["timeout 5 sed 's/x/y/e' file.txt", 'ask'],
    ["sed -n '1p' file.txt", 'passthrough'],
    ['echo hello', 'passthrough'],
  ] as const)('%s → %s', (command, expected) => {
    expect(behavior(command)).toBe(expected)
  })
})
