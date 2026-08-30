import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAllOutputStylesCache,
  getAllOutputStyles,
} from '../outputStyles.js'

const previousSafeMode = process.env.CLAUDE_CODE_SAFE_MODE

afterEach(() => {
  clearAllOutputStylesCache()
  if (previousSafeMode === undefined) {
    delete process.env.CLAUDE_CODE_SAFE_MODE
  } else {
    process.env.CLAUDE_CODE_SAFE_MODE = previousSafeMode
  }
})

test('safe mode loads only built-in output styles', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'output-style-safe-mode-'))
  try {
    const stylesDir = join(cwd, '.claude', 'output-styles')
    await mkdir(stylesDir, { recursive: true })
    await writeFile(
      join(stylesDir, 'custom.md'),
      '---\nname: Custom\ndescription: Custom style\n---\nCustom prompt',
    )
    process.env.CLAUDE_CODE_SAFE_MODE = '1'

    const styles = await getAllOutputStyles(cwd)

    expect(Object.keys(styles).sort()).toEqual([
      'Explanatory',
      'Learning',
      'default',
    ])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
