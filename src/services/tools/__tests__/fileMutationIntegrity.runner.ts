import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { symlinkSync, unlinkSync } from 'fs'
import {
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'fs/promises'
import { join } from 'path'
import type { NotebookContent } from '../../../types/notebook.js'
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
  clearGrowthBookConfigOverride: () => {},
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

const { FileWriteTool } = await import(
  '../../../tools/FileWriteTool/FileWriteTool.js'
)
const { NotebookEditTool } = await import(
  '../../../tools/NotebookEditTool/NotebookEditTool.js'
)
const { getFileModificationTime } = await import('../../../utils/file.js')
const { captureFileMutationPathEvidence, assertFileMutationPathUnchanged } =
  await import('../../../utils/fsOperations.js')
const { createFileStateCacheWithSizeLimit, isCompleteFileState } = await import(
  '../../../utils/fileStateCache.js'
)
const { projectNotebookCells } = await import('../../../utils/notebook.js')
const { jsonStringify } = await import('../../../utils/slowOperations.js')

const testDir = join(
  process.cwd(),
  `.tmp-file-mutation-integrity-${process.pid}`,
)
const parentMessage = { uuid: 'assistant-test' } as never

function emptyCache() {
  return createFileStateCacheWithSizeLimit(20)
}

function cacheText(
  path: string,
  content: string,
  overrides: {
    offset?: number
    limit?: number
    isPartialView?: boolean
  } = {},
) {
  const cache = emptyCache()
  cache.set(path, {
    content,
    timestamp: getFileModificationTime(path),
    offset: overrides.offset ?? 1,
    limit: overrides.limit,
    ...(overrides.isPartialView && { isPartialView: true }),
  })
  return cache
}

function cacheNotebook(
  path: string,
  notebook: NotebookContent,
  overrides: { limit?: number; isPartialView?: boolean } = {},
) {
  return cacheText(
    path,
    jsonStringify(projectNotebookCells(notebook)),
    overrides,
  )
}

function makeContext(
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>,
  assertMutationPathUnchanged?: () => void,
) {
  return {
    readFileState,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    assertMutationPathUnchanged,
  } as never
}

async function callWrite(
  path: string,
  content: string,
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>,
  assertMutationPathUnchanged?: () => void,
) {
  return FileWriteTool.call(
    { file_path: path, content },
    makeContext(readFileState, assertMutationPathUnchanged),
    async () => ({ behavior: 'allow' }) as never,
    parentMessage,
  )
}

function notebookFixture(): NotebookContent {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      language_info: { name: 'python' },
      kernelspec: { display_name: 'Python 3' },
    },
    cells: [
      {
        id: 'cell-a',
        cell_type: 'code',
        source: 'print("one")\n',
        metadata: { tag: 'original' },
        execution_count: 1,
        outputs: [],
      },
    ],
  } as unknown as NotebookContent
}

async function writeNotebook(path: string, notebook: NotebookContent) {
  await writeFile(path, jsonStringify(notebook, null, 1))
}

function notebookInput(path: string, source = 'print("edited")\n') {
  return {
    notebook_path: path,
    cell_id: 'cell-a',
    new_source: source,
    edit_mode: 'replace' as const,
  }
}

async function callNotebook(
  path: string,
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>,
  source?: string,
) {
  return NotebookEditTool.call(
    notebookInput(path, source),
    makeContext(readFileState),
    async () => ({ behavior: 'allow' }) as never,
    parentMessage,
  )
}

beforeAll(async () => {
  await mkdir(testDir, { recursive: true })
})

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('isCompleteFileState', () => {
  test('accepts a full first-offset file state', () => {
    expect(
      isCompleteFileState({
        content: 'full',
        timestamp: 1,
        offset: 1,
        limit: undefined,
      }),
    ).toBe(true)
  })

  test('rejects a limited file state', () => {
    expect(
      isCompleteFileState({
        content: 'limited',
        timestamp: 1,
        offset: 1,
        limit: 10,
      }),
    ).toBe(false)
  })

  test('rejects a non-first-offset file state', () => {
    expect(
      isCompleteFileState({
        content: 'offset',
        timestamp: 1,
        offset: 2,
        limit: undefined,
      }),
    ).toBe(false)
  })

  test('rejects an isPartialView file state', () => {
    expect(
      isCompleteFileState({
        content: 'partial',
        timestamp: 1,
        offset: 1,
        limit: undefined,
        isPartialView: true,
      }),
    ).toBe(false)
  })
})

describe('FileWriteTool.call integrity', () => {
  for (const state of ['missing', 'limited', 'partial-view'] as const) {
    test(`rejects an existing file with ${state} read state`, async () => {
      const path = join(testDir, `write-${state}.txt`)
      const original = 'original\n'
      await writeFile(path, original)
      const cache =
        state === 'missing'
          ? emptyCache()
          : cacheText(
              path,
              original,
              state === 'limited' ? { limit: 1 } : { isPartialView: true },
            )

      await expect(callWrite(path, 'replacement\n', cache)).rejects.toThrow(
        /unexpectedly modified/,
      )
      expect(await readFile(path, 'utf8')).toBe(original)
    })
  }

  test('rejects changed content even when mtime matches the cached read', async () => {
    const path = join(testDir, 'write-same-mtime.txt')
    const original = 'original\n'
    await writeFile(path, original)
    const cache = cacheText(path, original)
    const cachedMtime = cache.get(path)!.timestamp
    await writeFile(path, 'external\n')
    await utimes(path, new Date(cachedMtime), new Date(cachedMtime))
    expect(getFileModificationTime(path)).toBe(cachedMtime)

    await expect(callWrite(path, 'replacement\n', cache)).rejects.toThrow(
      /unexpectedly modified/,
    )
    expect(await readFile(path, 'utf8')).toBe('external\n')
  })

  test('allows a touched file whose content still matches the cached read', async () => {
    const path = join(testDir, 'write-touched.txt')
    const original = 'original\n'
    await writeFile(path, original)
    const cache = cacheText(path, original)
    const cachedMtime = cache.get(path)!.timestamp
    await utimes(
      path,
      new Date(cachedMtime + 2_000),
      new Date(cachedMtime + 2_000),
    )

    await callWrite(path, 'replacement\n', cache)
    expect(await readFile(path, 'utf8')).toBe('replacement\n')
  })

  test('accepts its own BOM and CR-normalized post-write cache', async () => {
    const path = join(testDir, 'write-normalized-state.txt')
    const cache = emptyCache()

    await callWrite(path, '\uFEFFfirst\r\nsecond\r', cache)
    await callWrite(path, 'replacement\n', cache)

    expect(await readFile(path, 'utf8')).toBe('replacement\n')
  })

  test('creates a nonexistent file with no cached state and missing parents', async () => {
    const path = join(testDir, 'new-parent', 'new-file.txt')

    const result = await callWrite(path, 'created\n', emptyCache())

    expect(result.data.type).toBe('create')
    expect(await readFile(path, 'utf8')).toBe('created\n')
  })
})

describe('NotebookEditTool integrity', () => {
  test('validate and call reject a partial processed-cells cache', async () => {
    const path = join(testDir, 'notebook-partial.ipynb')
    const notebook = notebookFixture()
    await writeNotebook(path, notebook)
    const cache = cacheNotebook(path, notebook, { limit: 1 })
    const rawBefore = await readFile(path, 'utf8')

    expect(
      await NotebookEditTool.validateInput(
        notebookInput(path),
        makeContext(cache),
      ),
    ).toMatchObject({ result: false, errorCode: 9 })
    const result = await callNotebook(path, cache)
    expect(result.data.error).toMatch(/unexpectedly modified/)
    expect(await readFile(path, 'utf8')).toBe(rawBefore)
  })

  test('allows an edit against the current processed-cells cache', async () => {
    const path = join(testDir, 'notebook-current.ipynb')
    const notebook = notebookFixture()
    await writeNotebook(path, notebook)
    const cache = cacheNotebook(path, notebook)

    expect(
      await NotebookEditTool.validateInput(
        notebookInput(path),
        makeContext(cache),
      ),
    ).toMatchObject({ result: true })
    const result = await callNotebook(path, cache)
    const written = JSON.parse(await readFile(path, 'utf8')) as NotebookContent
    expect(result.data.error).toBe('')
    expect(written.cells[0]!.source).toBe('print("edited")\n')
  })

  test('rejects an external cell change with the same mtime without rewriting it', async () => {
    const path = join(testDir, 'notebook-external-cell.ipynb')
    const notebook = notebookFixture()
    await writeNotebook(path, notebook)
    const cache = cacheNotebook(path, notebook)
    const cachedMtime = cache.get(path)!.timestamp
    const external = structuredClone(notebook)
    external.cells[0]!.source = 'print("external")\n'
    await writeNotebook(path, external)
    await utimes(path, new Date(cachedMtime), new Date(cachedMtime))
    expect(getFileModificationTime(path)).toBe(cachedMtime)
    const rawBefore = await readFile(path, 'utf8')

    expect(
      await NotebookEditTool.validateInput(
        notebookInput(path),
        makeContext(cache),
      ),
    ).toMatchObject({ result: false, errorCode: 10 })
    const result = await callNotebook(path, cache)
    expect(result.data.error).toMatch(/unexpectedly modified/)
    expect(await readFile(path, 'utf8')).toBe(rawBefore)
  })

  test('allows metadata-only raw changes and preserves the changed metadata', async () => {
    const path = join(testDir, 'notebook-metadata.ipynb')
    const notebook = notebookFixture()
    await writeNotebook(path, notebook)
    const cache = cacheNotebook(path, notebook)
    const metadataChanged = structuredClone(notebook) as NotebookContent & {
      metadata: { custom?: string }
    }
    metadataChanged.metadata.custom = 'preserve-me'
    await writeNotebook(path, metadataChanged)

    expect(
      await NotebookEditTool.validateInput(
        notebookInput(path),
        makeContext(cache),
      ),
    ).toMatchObject({ result: true })
    const result = await callNotebook(path, cache)
    const written = JSON.parse(
      await readFile(path, 'utf8'),
    ) as NotebookContent & {
      metadata: { custom?: string }
    }
    expect(result.data.error).toBe('')
    expect(written.metadata.custom).toBe('preserve-me')
    expect(written.cells[0]!.metadata).toEqual({ tag: 'original' })
  })
})

describe('file mutation path evidence', () => {
  test.skipIf(process.platform === 'win32')(
    'accepts a stable pre-existing symlink',
    async () => {
      const target = join(testDir, 'stable-target.txt')
      const link = join(testDir, 'stable-link.txt')
      await writeFile(target, 'stable\n')
      await symlink(target, link)
      const evidence = captureFileMutationPathEvidence(link)

      expect(() =>
        assertFileMutationPathUnchanged(evidence, link),
      ).not.toThrow()
    },
  )

  test.skipIf(process.platform === 'win32')(
    'rejects a leaf symlink target swap',
    async () => {
      const first = join(testDir, 'leaf-first.txt')
      const second = join(testDir, 'leaf-second.txt')
      const link = join(testDir, 'leaf-link.txt')
      await writeFile(first, 'first\n')
      await writeFile(second, 'second\n')
      await symlink(first, link)
      const evidence = captureFileMutationPathEvidence(link)
      await unlink(link)
      await symlink(second, link)

      expect(() => assertFileMutationPathUnchanged(evidence, link)).toThrow(
        /File target changed/,
      )
    },
  )

  test.skipIf(process.platform === 'win32')(
    'rejects a parent directory replaced by a symlink',
    async () => {
      const parent = join(testDir, 'parent-original')
      const replacement = join(testDir, 'parent-replacement')
      const path = join(parent, 'file.txt')
      await mkdir(parent)
      await mkdir(replacement)
      await writeFile(path, 'original\n')
      await writeFile(join(replacement, 'file.txt'), 'replacement\n')
      const evidence = captureFileMutationPathEvidence(path)
      await rm(parent, { recursive: true })
      await symlink(replacement, parent, 'dir')

      expect(() => assertFileMutationPathUnchanged(evidence, path)).toThrow(
        /File target changed/,
      )
    },
  )

  test('accepts normal parent creation for an initially missing path', async () => {
    const parent = join(testDir, 'evidence-new-parent')
    const path = join(parent, 'file.txt')
    const evidence = captureFileMutationPathEvidence(path)
    await mkdir(parent, { recursive: true })

    expect(() => assertFileMutationPathUnchanged(evidence, path)).not.toThrow()
  })
})

describe('FileWriteTool.call path assertion', () => {
  test.skipIf(process.platform === 'win32')(
    'rejects a late symlink target change before writing',
    async () => {
      const approved = join(testDir, 'late-approved.txt')
      const replacement = join(testDir, 'late-replacement.txt')
      const link = join(testDir, 'late-link.txt')
      await writeFile(approved, 'approved\n')
      await writeFile(replacement, 'replacement\n')
      await symlink(approved, link)
      const cache = cacheText(link, 'approved\n')
      const evidence = captureFileMutationPathEvidence(link)
      let assertionCalls = 0
      const assertMutationPathUnchanged = () => {
        assertionCalls++
        assertFileMutationPathUnchanged(evidence, link)
        if (assertionCalls === 1) {
          unlinkSync(link)
          symlinkSync(replacement, link)
        }
      }

      await expect(
        callWrite(link, 'attempted\n', cache, assertMutationPathUnchanged),
      ).rejects.toThrow(/File target changed/)
      expect(assertionCalls).toBe(2)
      expect(await readFile(approved, 'utf8')).toBe('approved\n')
      expect(await readFile(replacement, 'utf8')).toBe('replacement\n')
    },
  )
})
