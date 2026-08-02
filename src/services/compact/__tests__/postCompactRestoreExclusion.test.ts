/**
 * Regression: shouldExcludeFromPostCompactRestore needs TWO checks, not one.
 *
 * A standing TODO in compact.ts read "Refactor to use isMemoryFilePath()".
 * Taken literally that deletes the exact-path set — and isMemoryFilePath only
 * matches CLAUDE.md / CLAUDE.local.md / .claude/rules/*.md, never MEMORY.md.
 * The AutoMem and TeamMem entrypoints are both named MEMORY.md, so collapsing
 * the two checks re-injects them on every compaction: no error, no failing
 * test, just a few thousand wasted tokens per compact, visible only on the
 * bill. Hence a direct assertion on the predicate.
 */
import { describe, expect, test } from 'bun:test'
import { getMemoryPath } from '../../../utils/config'
import { shouldExcludeFromPostCompactRestore } from '../compact'

describe('shouldExcludeFromPostCompactRestore', () => {
  // Resolved at runtime, not hardcoded — the path embeds the home dir and a
  // per-project slug, so a literal would only hold on one machine.
  test('excludes the AutoMem MEMORY.md entrypoint (needs the exact-path check)', () => {
    expect(shouldExcludeFromPostCompactRestore(getMemoryPath('AutoMem'))).toBe(
      true,
    )
  })

  // Single-letter first segments are unusable here: expandPath treats /p/... as
  // a Windows drive-letter path (utils/path.ts, ^/[a-z]/ branch), and any suite
  // that mock.modules platform.js to 'windows' — shellDefaults.windows.test.ts
  // does — is process-global, so it would rewrite these to P:\... and the
  // basename check would stop matching. Hence /project/, as in claudemd.test.ts.
  test('excludes CLAUDE.md variants anywhere in the tree', () => {
    expect(shouldExcludeFromPostCompactRestore('/project/CLAUDE.md')).toBe(true)
    expect(
      shouldExcludeFromPostCompactRestore('/project/sub/dir/CLAUDE.md'),
    ).toBe(true)
    expect(
      shouldExcludeFromPostCompactRestore('/project/CLAUDE.local.md'),
    ).toBe(true)
    expect(
      shouldExcludeFromPostCompactRestore('/project/sub/.claude/rules/deep.md'),
    ).toBe(true)
  })

  test('does not exclude ordinary files', () => {
    expect(shouldExcludeFromPostCompactRestore('/project/src/main.ts')).toBe(
      false,
    )
    expect(shouldExcludeFromPostCompactRestore('/project/README.md')).toBe(
      false,
    )
  })
})
