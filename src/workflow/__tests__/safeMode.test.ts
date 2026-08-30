import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getWorkflowCommands } from '../namedWorkflowCommands.js'
import { createWorkflowToolCore } from '../wiring.js'

const previousSafeMode = process.env.CLAUDE_CODE_SAFE_MODE

afterEach(() => {
  if (previousSafeMode === undefined) {
    delete process.env.CLAUDE_CODE_SAFE_MODE
  } else {
    process.env.CLAUDE_CODE_SAFE_MODE = previousSafeMode
  }
})

test('safe mode disables custom workflow commands and the Workflow tool', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-safe-mode-'))
  try {
    const workflowsDir = join(cwd, '.claude', 'workflows')
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(join(workflowsDir, 'demo.ts'), 'export default {}')
    process.env.CLAUDE_CODE_SAFE_MODE = '1'

    expect(await getWorkflowCommands(cwd)).toEqual([])
    expect(createWorkflowToolCore().isEnabled()).toBe(false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
