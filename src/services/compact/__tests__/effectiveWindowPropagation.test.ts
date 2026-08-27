import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getSdkBetas, setSdkBetas } from '../../../bootstrap/state.js'
import { CONTEXT_1M_BETA_HEADER } from '../../../constants/betas.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { createSubagentContext } from '../../../utils/forkedAgent.js'
import { getAutoCompactThreshold } from '../autoCompact.js'
import { getEffectiveContextWindowSize } from '../effectiveWindow.js'

const root = join(import.meta.dir, '../../../..')
const source = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('effective context window propagation', () => {
  test('main resolves the session override once for headless and REPL entrypoints', () => {
    const main = source('src/main.tsx')

    expect(main).toContain('--autocompact <window>')
    expect(main).toContain(
      'getEffectiveContextWindowSize(resolvedInitialModel, options.autocompact)',
    )
    expect(main).toContain('effectiveContextWindow,')
  })

  test('main and subagents share the reserve-adjusted numeric threshold', () => {
    const model = 'claude-sonnet-4-20250514'
    const previousBetas = getSdkBetas()
    try {
      setSdkBetas([CONTEXT_1M_BETA_HEADER])
      const mainWindow = getEffectiveContextWindowSize(model, '200k')
      const parentContext = {
        effectiveContextWindow: mainWindow,
        messages: [],
        abortController: new AbortController(),
        readFileState: createFileStateCacheWithSizeLimit(1),
        getAppState: () => ({}),
        setAppState() {},
      } as never
      const subagentContext = createSubagentContext(parentContext)

      expect(mainWindow).toBe(180_000)
      expect(getAutoCompactThreshold(model, mainWindow)).toBe(167_000)
      expect(subagentContext.effectiveContextWindow).toBe(180_000)
      expect(
        getAutoCompactThreshold(model, subagentContext.effectiveContextWindow),
      ).toBe(167_000)
    } finally {
      setSdkBetas(previousBetas)
    }
  })

  test('query passes the resolved window into proactive and reactive compact contexts', () => {
    const query = source('src/query.ts')

    expect(query).toContain('effectiveContextWindow?: number')
    expect(query).toContain('effectiveContextWindow,')
    expect(query).toContain(
      'effectiveContextWindow: toolUseContext.effectiveContextWindow',
    )
  })

  test('main, forked, resumed, and in-process agents inherit the parent window', () => {
    const agentSources = [
      source('src/utils/forkedAgent.ts'),
      source('src/tools/AgentTool/AgentTool.tsx'),
      source('src/tools/AgentTool/runAgent.ts'),
      source('src/tools/AgentTool/resumeAgent.ts'),
      source('src/utils/swarm/inProcessRunner.ts'),
    ].join('\n')

    expect(agentSources).toContain(
      'effectiveContextWindow: parentContext.effectiveContextWindow',
    )
    expect(agentSources).toContain(
      'effectiveContextWindow: toolUseContext.effectiveContextWindow',
    )
  })

  test('QueryEngine and sideQuery accept the already-resolved window', () => {
    const engine = source('src/QueryEngine.ts')
    const sideQuery = source('src/utils/sideQuery.ts')

    expect(engine).toContain('effectiveContextWindow?: number')
    expect(engine).toContain(
      'effectiveContextWindow: this.config.effectiveContextWindow',
    )
    expect(sideQuery).toContain('effectiveContextWindow?: number')
  })
})
