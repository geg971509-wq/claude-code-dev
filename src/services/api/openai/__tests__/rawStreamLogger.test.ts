import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  _flushOpenAIRawStreamLogForTesting,
  _resetOpenAIRawStreamLoggerForTesting,
  _setOpenAIRawStreamLoggerForTesting,
  getOpenAIRawStreamLogPath,
  isOpenAIRawStreamLoggingEnabled,
  logOpenAIRawStream,
} from '../rawStreamLogger.js'

type RawEvent = Record<string, unknown>

const originalArgv = [...process.argv]
const originalNodeEnv = process.env.NODE_ENV

async function* fromEvents(events: RawEvent[]): AsyncGenerator<RawEvent, void> {
  for (const event of events) yield event
}

function readRows(path: string): RawEvent[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as RawEvent)
}

afterEach(() => {
  process.argv = [...originalArgv]
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  _resetOpenAIRawStreamLoggerForTesting()
})

describe('isOpenAIRawStreamLoggingEnabled', () => {
  test('is enabled by default and disabled by the explicit startup flag', () => {
    expect(isOpenAIRawStreamLoggingEnabled(['claude'], 'production')).toBe(true)
    expect(
      isOpenAIRawStreamLoggingEnabled(
        ['claude', '--no-openai-raw-log'],
        'production',
      ),
    ).toBe(false)
  })

  test('keeps the existing suite file-silent under NODE_ENV=test', () => {
    expect(isOpenAIRawStreamLoggingEnabled(['claude'], 'test')).toBe(false)
    _setOpenAIRawStreamLoggerForTesting({
      enabled: true,
      argv: ['claude'],
    })
    expect(isOpenAIRawStreamLoggingEnabled(['claude'], 'test')).toBe(true)
    _setOpenAIRawStreamLoggerForTesting({
      enabled: true,
      argv: ['claude', '--no-openai-raw-log'],
    })
    expect(isOpenAIRawStreamLoggingEnabled(['claude'], 'test')).toBe(false)
  })
})

describe('logOpenAIRawStream', () => {
  test('logs response events and chat chunks without changing their identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path })

    const responseEvent = {
      type: 'response.output_text.delta',
      delta: '**Plan [N]**\n下一步',
      nested: { quote: '"quoted"', unicode: '中文' },
    }
    const chatChunk = {
      id: 'chatcmpl-test',
      choices: [{ delta: { content: 'done' } }],
      usage: { prompt_tokens: 3 },
    }

    const responseOutput: RawEvent[] = []
    for await (const event of logOpenAIRawStream(fromEvents([responseEvent]), {
      route: 'official-responses',
      model: 'gpt-5',
      source: 'repl_main_thread',
    })) {
      responseOutput.push(event)
    }
    const chatOutput: RawEvent[] = []
    for await (const event of logOpenAIRawStream(fromEvents([chatChunk]), {
      route: 'chat-completions',
      model: 'deepseek-chat',
    })) {
      chatOutput.push(event)
    }
    _flushOpenAIRawStreamLogForTesting()

    expect(responseOutput[0]).toBe(responseEvent)
    expect(chatOutput[0]).toBe(chatChunk)
    expect(existsSync(path)).toBe(true)

    const rows = readRows(path)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      protocol: 'responses',
      route: 'official-responses',
      model: 'gpt-5',
      source: 'repl_main_thread',
      sequence: 0,
      event: responseEvent,
    })
    expect(rows[1]).toMatchObject({
      protocol: 'chat-completions',
      route: 'chat-completions',
      model: 'deepseek-chat',
      sequence: 0,
      event: chatChunk,
    })
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'event',
      'model',
      'protocol',
      'route',
      'sequence',
      'sessionId',
      'source',
      'streamId',
      'timestamp',
    ])
    expect(rows[0]!.streamId).not.toBe(rows[1]!.streamId)
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(
      2,
    )

    rmSync(root, { recursive: true, force: true })
  })

  test('keeps a stream bound to its initial output path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const firstPath = join(root, 'first.openai.jsonl')
    const secondPath = join(root, 'second.openai.jsonl')
    let releaseNext: (() => void) | undefined
    const nextEvent = new Promise<void>(resolve => {
      releaseNext = resolve
    })
    const stream: AsyncIterable<RawEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'first' }
        await nextEvent
        yield { type: 'second' }
      },
    }

    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path: firstPath })
    const wrapped = logOpenAIRawStream(stream, {
      route: 'official-responses',
      model: 'gpt-5',
    })
    await wrapped.next()
    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path: secondPath })
    releaseNext?.()
    await wrapped.next()
    await wrapped.return?.()
    _flushOpenAIRawStreamLogForTesting()

    expect(readRows(firstPath).map(row => row.event)).toEqual([
      { type: 'first' },
      { type: 'second' },
    ])
    expect(existsSync(secondPath)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test('honors the configured log directory and requests private permissions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'nested', 'session.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path })

    for await (const _event of logOpenAIRawStream(
      fromEvents([{ type: 'done' }]),
      {
        route: 'chatgpt-responses',
        model: 'gpt-5.5',
      },
    )) {
      // consume the stream
    }
    _flushOpenAIRawStreamLogForTesting()

    expect(getOpenAIRawStreamLogPath()).toBe(path)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'nested')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    rmSync(root, { recursive: true, force: true })
  })

  test('does not create a file when the startup opt-out is present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    process.env.NODE_ENV = 'production'
    process.argv = [...originalArgv, '--no-openai-raw-log']
    _setOpenAIRawStreamLoggerForTesting({ path })

    const event = { type: 'response.output_text.delta', delta: 'hidden' }
    const output: RawEvent[] = []
    for await (const value of logOpenAIRawStream(fromEvents([event]), {
      route: 'official-responses',
      model: 'gpt-5',
    })) {
      output.push(value)
    }

    expect(output[0]).toBe(event)
    expect(existsSync(path)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test('continues when an event cannot be serialized', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path })

    const event: RawEvent = { type: 'circular' }
    event.self = event
    const output: RawEvent[] = []
    for await (const value of logOpenAIRawStream(fromEvents([event]), {
      route: 'official-responses',
      model: 'gpt-5',
    })) {
      output.push(value)
    }

    expect(output[0]).toBe(event)
    expect(existsSync(path)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test('preserves upstream errors and iterator cleanup when logging fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const blocker = join(root, 'not-a-directory')
    require('fs').writeFileSync(blocker, 'blocker')
    _setOpenAIRawStreamLoggerForTesting({
      enabled: true,
      path: join(blocker, 'events.openai.jsonl'),
    })

    let returned = false
    const stream: AsyncIterable<RawEvent> = {
      [Symbol.asyncIterator]() {
        let yielded = false
        return {
          async next() {
            if (yielded) throw new Error('upstream failure')
            yielded = true
            return { done: false, value: { type: 'first' } }
          },
          async return() {
            returned = true
            return { done: true, value: undefined }
          },
        }
      },
    }

    const wrapped = logOpenAIRawStream(stream, {
      route: 'official-responses',
      model: 'gpt-5',
    })
    expect((await wrapped.next()).value).toEqual({ type: 'first' })
    await wrapped.return?.()
    expect(returned).toBe(true)

    const failingStream: AsyncIterable<RawEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'before-error' }
        throw new Error('upstream failure')
      },
    }
    const consume = async () => {
      for await (const _event of logOpenAIRawStream(failingStream, {
        route: 'official-responses',
        model: 'gpt-5',
      })) {
        // consume the stream
      }
    }
    await expect(consume()).rejects.toThrow('upstream failure')

    rmSync(root, { recursive: true, force: true })
  })
})
