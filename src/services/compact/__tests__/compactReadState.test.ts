import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolUseContext } from '../../../Tool.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { Message } from '../../../types/message.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  type FileState,
  type FileStateCache,
} from '../../../utils/fileStateCache.js'
import { FILE_UNCHANGED_STUB } from '../../../tools/FileReadTool/prompt.js'
import {
  createPostCompactFileAttachments,
  dropRegenerableAttachments,
} from '../compact.js'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'compact-read-state-'))
  process.env.CLAUDE_CODE_SIMPLE = '1'
})

afterAll(async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  await rm(dir, { recursive: true, force: true })
})

function state(overrides: Partial<FileState> = {}): FileState {
  return {
    content: 'prior',
    timestamp: 1,
    offset: 1,
    limit: undefined,
    ...overrides,
  }
}

function context(readFileState: FileStateCache): ToolUseContext {
  return {
    readFileState,
    abortController: new AbortController(),
    getAppState: () => ({
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

function preservedRead(
  id: string,
  filename: string,
  result: string,
  range?: { offset: number; limit: number },
): Message[] {
  return [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id,
            name: 'Read',
            input: { file_path: filename, ...range },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: result.startsWith(FILE_UNCHANGED_STUB)
              ? result
              : result
                  .split('\n')
                  .map(
                    (line, index) => `${(range?.offset ?? 1) + index}\t${line}`,
                  )
                  .join('\n'),
          },
        ],
      },
    },
  ] as unknown as Message[]
}

async function restore(
  snapshot: FileStateCache,
  maxFiles: number,
  preserved: Message[] = [],
) {
  const active = createFileStateCacheWithSizeLimit(
    snapshot.max,
    snapshot.maxSize,
  )
  const attachments = await createPostCompactFileAttachments(
    Array.from(snapshot.entries()),
    context(active),
    maxFiles,
    preserved,
  )
  return { active, attachments }
}

describe('compact read state', () => {
  test('selects MRU rather than newest timestamp', async () => {
    const newerMtime = join(dir, 'newer-mtime.txt')
    const mostRecent = join(dir, 'most-recent.txt')
    await Promise.all([
      writeFile(newerMtime, 'newer mtime'),
      writeFile(mostRecent, 'most recent'),
    ])
    const snapshot = createFileStateCacheWithSizeLimit(10)
    snapshot.set(newerMtime, state({ timestamp: 999 }))
    snapshot.set(mostRecent, state({ timestamp: 1 }))

    const { active, attachments } = await restore(snapshot, 1)

    expect(attachments.map(message => message.attachment.filename)).toEqual([
      mostRecent,
    ])
    expect(Array.from(active.keys())).toEqual([mostRecent])
  })

  test('preserves exact full and ranged states without duplicate attachments', async () => {
    const full = join(dir, 'full.txt')
    const ranged = join(dir, 'ranged.txt')
    await Promise.all([
      writeFile(full, 'disk full'),
      writeFile(ranged, 'disk ranged'),
    ])
    const fullState = state({ content: 'full prior', timestamp: 11 })
    const rangedState = state({
      content: 'ranged prior',
      timestamp: 22,
      offset: 3,
      limit: 2,
      isPartialView: true,
    })
    const snapshot = createFileStateCacheWithSizeLimit(10)
    snapshot.set(full, fullState)
    snapshot.set(ranged, rangedState)
    const preserved = [
      ...preservedRead('read-full', full, 'full prior'),
      ...preservedRead('read-range', ranged, 'ranged prior', {
        offset: 3,
        limit: 2,
      }),
    ]

    const { active, attachments } = await restore(snapshot, 5, preserved)

    expect(attachments).toEqual([])
    expect(active.get(full)).toEqual(fullState)
    expect(active.get(ranged)).toEqual(rangedState)
    expect(Array.from(active.keys())).toEqual([ranged, full])
  })

  test('rereads when a preserved same-path result is stale', async () => {
    const filename = join(dir, 'stale-preserved.txt')
    await writeFile(filename, 'new content')
    const snapshot = createFileStateCacheWithSizeLimit(10)
    snapshot.set(filename, state({ content: 'new content', timestamp: 0 }))

    const { active, attachments } = await restore(
      snapshot,
      5,
      preservedRead('old-read', filename, 'old content'),
    )

    expect(attachments.map(message => message.attachment.type)).toEqual([
      'file',
    ])
    expect(active.get(filename)?.content).toBe('new content')
  })

  test('unchanged stub forces a real reread', async () => {
    const filename = join(dir, 'stub.txt')
    await writeFile(filename, 'fresh from disk')
    const snapshot = createFileStateCacheWithSizeLimit(10)
    snapshot.set(filename, state({ content: 'stale prior', timestamp: 0 }))

    const { active, attachments } = await restore(
      snapshot,
      5,
      preservedRead('stub-read', filename, FILE_UNCHANGED_STUB),
    )

    expect(attachments.map(message => message.attachment.type)).toEqual([
      'file',
    ])
    expect(active.get(filename)?.content).toBe('fresh from disk')
  })

  test('does not cache null, compact references, or over-budget files', async () => {
    const missing = join(dir, 'missing.txt')
    const tooLarge = join(dir, 'too-large.txt')
    await writeFile(tooLarge, 'x'.repeat(13_000))
    const snapshot = createFileStateCacheWithSizeLimit(100)
    const regularFiles = await Promise.all(
      Array.from({ length: 80 }, async (_, index) => {
        const filename = join(dir, `budget-${index}.txt`)
        await writeFile(filename, `${index}:` + 'x'.repeat(900))
        snapshot.set(filename, state())
        return filename
      }),
    )
    snapshot.set(missing, state())
    snapshot.set(tooLarge, state())

    const { active, attachments } = await restore(snapshot, snapshot.size)
    const keptFiles = new Set(
      attachments.flatMap(message =>
        message.attachment.type === 'file' ? [message.attachment.filename] : [],
      ),
    )
    const overBudget = regularFiles.find(filename => !keptFiles.has(filename))

    expect(
      attachments.some(
        message => message.attachment.type === 'compact_file_reference',
      ),
    ).toBe(true)
    expect(overBudget).toBeDefined()
    expect(active.has(missing)).toBe(false)
    expect(active.has(tooLarge)).toBe(false)
    expect(active.has(overBudget!)).toBe(false)
    expect(active.size).toBe(keptFiles.size)
  })

  test('recompaction drops file credentials while non-drop paths keep them', () => {
    const filename = join(dir, 'drop.txt')
    const attachment = {
      type: 'attachment',
      attachment: {
        type: 'file',
        filename,
        content: { type: 'text', file: { content: 'data' } },
        displayPath: 'drop.txt',
      },
    } as never
    const active = createFileStateCacheWithSizeLimit(10)
    active.set(filename, state())

    expect(dropRegenerableAttachments([attachment], 1, active)).toHaveLength(1)
    expect(active.has(filename)).toBe(true)
    expect(dropRegenerableAttachments([attachment], 0, active)).toEqual([])
    expect(active.has(filename)).toBe(false)
  })
})
