import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdir, readFile, rm, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: async () => {},
  stripProtoFields: <T>(value: T) => value,
  attachAnalyticsSink: () => {},
}))
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getFeatureValue_DEPRECATED: async () => undefined,
  getFeatureValue_CACHED_WITH_REFRESH: async () => undefined,
  hasGrowthBookEnvOverride: () => false,
  getAllGrowthBookFeatures: () => ({}),
  getGrowthBookConfigOverrides: () => ({}),
  setGrowthBookConfigOverride: () => {},
  clearGrowthBookConfigOverrides: () => {},
  getApiBaseUrlHost: () => undefined,
  onGrowthBookRefresh: () => {},
  initializeGrowthBook: async () => {},
  checkSecurityRestrictionGate: async () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  refreshGrowthBookAfterAuthChange: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
  getDynamicConfig_BLOCKS_ON_INIT: async () => undefined,
  getDynamicConfig_CACHED_MAY_BE_STALE: () => undefined,
}))

;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'

const { FileEditTool } = await import('../FileEditTool.js')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')
const { createFileStateCacheWithSizeLimit } = await import(
  '../../../utils/fileStateCache.js'
)
const { getFileModificationTime } = await import('../../../utils/file.js')
const { withFileMutationLock, resetFileMutationLocksForTesting } = await import(
  '../../../services/tools/fileMutationQueue.js'
)

const testDir = join(process.cwd(), `.tmp-stale-recovery-${process.pid}`)
const testFile = join(testDir, 'shared.txt')
const parentMessage = {
  uuid: 'assistant-test',
  message: { model: 'test-model' },
} as never

function makeCache(content?: string, isPartialView: boolean = false) {
  const cache = createFileStateCacheWithSizeLimit(10)
  if (content !== undefined) {
    cache.set(testFile, {
      content,
      timestamp: getFileModificationTime(testFile),
      offset: 1,
      limit: undefined,
      ...(isPartialView && { isPartialView: true }),
    })
  }
  return cache
}

function makeContext(
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>,
  readRule?: 'ask' | 'deny',
) {
  const permissionContext = getEmptyToolPermissionContext()
  const rule = `Read(.tmp-stale-recovery-${process.pid}/shared.txt)`
  if (readRule === 'deny') {
    permissionContext.alwaysDenyRules.localSettings = [rule]
  } else if (readRule === 'ask') {
    permissionContext.alwaysAskRules.localSettings = [rule]
  }
  return {
    readFileState,
    getAppState: () => ({ toolPermissionContext: permissionContext }),
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
  } as never
}

async function edit(
  input: {
    old_string: string
    new_string: string
    replace_all?: boolean
  },
  context: ReturnType<typeof makeContext>,
) {
  return withFileMutationLock(testFile, () =>
    FileEditTool.call(
      { file_path: testFile, ...input },
      context,
      async () => ({ behavior: 'allow' }) as never,
      parentMessage,
    ),
  )
}

async function seed(content: string) {
  await writeFile(testFile, content)
  await Bun.sleep(5)
}

beforeAll(async () => {
  await mkdir(testDir, { recursive: true })
})

afterAll(async () => {
  resetFileMutationLocksForTesting()
  await rm(testDir, { recursive: true, force: true })
})

describe('FileEditTool stale recovery', () => {
  test('preserves non-overlapping edits from independent read caches', async () => {
    const original = 'alpha=1\nbeta=1\n'
    await seed(original)
    const firstCache = makeCache(original)
    const secondCache = makeCache(original)

    const [first, second] = await Promise.all([
      edit(
        { old_string: 'alpha=1', new_string: 'alpha=2' },
        makeContext(firstCache),
      ),
      edit(
        { old_string: 'beta=1', new_string: 'beta=2' },
        makeContext(secondCache),
      ),
    ])

    expect(await readFile(testFile, 'utf8')).toBe('alpha=2\nbeta=2\n')
    expect(first.data.staleRecovered).toBeUndefined()
    expect(second.data.staleRecovered).toBe(true)
    expect(secondCache.has(testFile)).toBe(false)
    const toolResult = FileEditTool.mapToolResultToToolResultBlockParam(
      second.data,
      'tool-2',
    )
    expect(toolResult.content).toContain('read it again')
  })

  test('keeps rejecting a target changed by the first edit', async () => {
    const original = 'alpha=1\nbeta=1\n'
    await seed(original)
    const firstCache = makeCache(original)
    const secondCache = makeCache(original)

    const first = edit(
      { old_string: 'alpha=1', new_string: 'alpha=2' },
      makeContext(firstCache),
    )
    const second = edit(
      { old_string: 'alpha=1', new_string: 'alpha=3' },
      makeContext(secondCache),
    )

    await first
    await expect(second).rejects.toThrow(/unexpectedly modified/)
    expect(await readFile(testFile, 'utf8')).toBe('alpha=2\nbeta=1\n')
  })

  test('rejects a newly ambiguous target unless replace_all is true', async () => {
    const original = 'source\ntarget\n'
    await seed(original)
    const firstCache = makeCache(original)
    const secondCache = makeCache(original)

    await edit(
      { old_string: 'source', new_string: 'target' },
      makeContext(firstCache),
    )
    await expect(
      edit(
        { old_string: 'target', new_string: 'done' },
        makeContext(secondCache),
      ),
    ).rejects.toThrow(/unexpectedly modified/)

    await seed(original)
    const thirdCache = makeCache(original)
    const fourthCache = makeCache(original)
    await edit(
      { old_string: 'source', new_string: 'target' },
      makeContext(thirdCache),
    )
    const recovered = await edit(
      { old_string: 'target', new_string: 'done', replace_all: true },
      makeContext(fourthCache),
    )
    expect(recovered.data.staleRecovered).toBe(true)
    expect(await readFile(testFile, 'utf8')).toBe('done\ndone\n')
  })

  test('uses content changes when concurrent writes share the same mtime', async () => {
    const original = 'alpha=1\nbeta=1\n'
    await seed(original)
    const cache = makeCache(original)
    const originalMtime = cache.get(testFile)!.timestamp
    await writeFile(testFile, 'alpha=2\nbeta=1\n')
    await utimes(testFile, new Date(originalMtime), new Date(originalMtime))

    const recovered = await edit(
      { old_string: 'beta=1', new_string: 'beta=2' },
      makeContext(cache),
    )
    expect(recovered.data.staleRecovered).toBe(true)
    expect(cache.has(testFile)).toBe(false)
    expect(await readFile(testFile, 'utf8')).toBe('alpha=2\nbeta=2\n')

    const ambiguousOriginal = 'source\ntarget\n'
    await seed(ambiguousOriginal)
    const ambiguousCache = makeCache(ambiguousOriginal)
    const ambiguousMtime = ambiguousCache.get(testFile)!.timestamp
    await writeFile(testFile, 'target\ntarget\n')
    await utimes(testFile, new Date(ambiguousMtime), new Date(ambiguousMtime))
    await expect(
      edit(
        { old_string: 'target', new_string: 'done' },
        makeContext(ambiguousCache),
      ),
    ).rejects.toThrow(/unexpectedly modified/)
  })

  test('does not recover without a full readable prior state', async () => {
    const original = 'alpha=1\nbeta=1\n'
    for (const state of ['missing', 'partial'] as const) {
      await seed(original)
      const firstCache = makeCache(original)
      const secondCache =
        state === 'missing' ? makeCache() : makeCache(original, true)
      const input = {
        file_path: testFile,
        old_string: 'beta=1',
        new_string: 'beta=2',
        replace_all: false,
      }
      expect(
        await FileEditTool.validateInput(input, makeContext(secondCache)),
      ).toMatchObject({ result: false, errorCode: 6 })
      await edit(
        { old_string: 'alpha=1', new_string: 'alpha=2' },
        makeContext(firstCache),
      )
      await expect(
        edit(
          { old_string: 'beta=1', new_string: 'beta=2' },
          makeContext(secondCache),
        ),
      ).rejects.toThrow(/unexpectedly modified/)
    }

    await seed(original)
    const partialCache = makeCache(original, true)
    const input = {
      file_path: testFile,
      old_string: 'beta=1',
      new_string: 'beta=2',
      replace_all: false,
    }
    expect(
      await FileEditTool.validateInput(input, makeContext(partialCache)),
    ).toMatchObject({ result: false, errorCode: 6 })
    await expect(edit(input, makeContext(partialCache))).rejects.toThrow(
      /unexpectedly modified/,
    )
  })

  test('does not recover when current read permission asks or denies', async () => {
    const original = 'alpha=1\nbeta=1\n'
    for (const readRule of ['ask', 'deny'] as const) {
      await seed(original)
      const firstCache = makeCache(original)
      const secondCache = makeCache(original)
      await edit(
        { old_string: 'alpha=1', new_string: 'alpha=2' },
        makeContext(firstCache),
      )
      await expect(
        edit(
          { old_string: 'beta=1', new_string: 'beta=2' },
          makeContext(secondCache, readRule),
        ),
      ).rejects.toThrow(/unexpectedly modified/)
    }
  })

  test('validateInput preflight and locked call share recovery rules', async () => {
    const original = 'alpha=1\nbeta=1\n'
    await seed(original)
    const firstCache = makeCache(original)
    const secondCache = makeCache(original)
    await edit(
      { old_string: 'alpha=1', new_string: 'alpha=2' },
      makeContext(firstCache),
    )

    const input = {
      file_path: testFile,
      old_string: 'beta=1',
      new_string: 'beta=2',
      replace_all: false,
    }
    const context = makeContext(secondCache)
    expect(await FileEditTool.validateInput(input, context)).toMatchObject({
      result: true,
    })
    const recovered = await edit(input, context)
    expect(recovered.data.staleRecovered).toBe(true)

    await seed(original)
    const conflictCache = makeCache(original)
    const writerCache = makeCache(original)
    await edit(
      { old_string: 'alpha=1', new_string: 'alpha=2' },
      makeContext(writerCache),
    )
    const conflict = await FileEditTool.validateInput(
      {
        file_path: testFile,
        old_string: 'alpha=1',
        new_string: 'alpha=3',
        replace_all: false,
      },
      makeContext(conflictCache),
    )
    expect(conflict).toMatchObject({ result: false, errorCode: 7 })
  })

  test('keeps the ordinary success result unchanged', async () => {
    const original = 'alpha=1\n'
    await seed(original)
    const cache = makeCache(original)
    const result = await edit(
      { old_string: 'alpha=1', new_string: 'alpha=2' },
      makeContext(cache),
    )
    const toolResult = FileEditTool.mapToolResultToToolResultBlockParam(
      result.data,
      'tool-1',
    )
    expect(result.data.staleRecovered).toBeUndefined()
    expect(toolResult.content).toBe(
      `The file ${testFile} has been updated successfully.`,
    )
  })
})
