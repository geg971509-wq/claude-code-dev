import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _flushOpenAIRawStreamLogForTesting,
  _resetOpenAIRawStreamLoggerForTesting,
  _setOpenAIRawStreamLoggerForTesting,
  getOpenAIRawStreamLogPath,
  isOpenAIRawStreamLoggingEnabled,
  logOpenAIRawLifecycle,
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
  test('logs ordered lifecycle rows, raw events, and completion state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path })

    const deltaEvent = {
      type: 'response.output_text.delta',
      delta: '**Plan [N]**\n下一步',
      nested: { quote: '"quoted"', unicode: '中文' },
    }
    const completedEvent = {
      type: 'response.completed',
      response: { status: 'completed' },
    }
    const output: RawEvent[] = []

    for await (const event of logOpenAIRawStream(
      fromEvents([deltaEvent, completedEvent]),
      {
        route: 'official-responses',
        model: 'gpt-5',
        source: 'repl_main_thread',
        streamId: 'stream-fixed',
        requestAttempt: 2,
        streamAttempt: 1,
        requestId: 'req-fixed',
      },
    )) {
      output.push(event)
    }
    _flushOpenAIRawStreamLogForTesting()

    expect(output[0]).toBe(deltaEvent)
    expect(output[1]).toBe(completedEvent)
    const rows = readRows(path)
    expect(rows.map(row => row.lifecycle)).toEqual([
      'start',
      'event',
      'event',
      'complete',
    ])
    expect(rows[0]).toMatchObject({
      protocol: 'responses',
      route: 'official-responses',
      model: 'gpt-5',
      source: 'repl_main_thread',
      streamId: 'stream-fixed',
      requestAttempt: 2,
      streamAttempt: 1,
      requestId: 'req-fixed',
      status: null,
    })
    expect(rows[1]).toMatchObject({ sequence: 0, event: deltaEvent })
    expect(rows[2]).toMatchObject({ sequence: 1, event: completedEvent })
    expect(rows[3]).toMatchObject({ eventCount: 2, status: 'completed' })
    expect(Object.keys(rows[1]!).sort()).toEqual([
      'event',
      'lifecycle',
      'model',
      'protocol',
      'requestAttempt',
      'requestId',
      'route',
      'sequence',
      'sessionId',
      'source',
      'status',
      'streamAttempt',
      'streamId',
      'timestamp',
    ])

    rmSync(root, { recursive: true, force: true })
  })

  test('logs start and error for a first-event failure and preserves its identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path })

    const upstreamError = Object.assign(new Error('upstream failure'), {
      status: 503,
      requestId: 'req-error',
      code: 'server_error',
      type: 'api_error',
      param: 'model',
      incompleteReason: 'server_error',
    })
    const failingStream: AsyncIterable<RawEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw upstreamError
          },
        }
      },
    }

    let caught: unknown
    try {
      for await (const _event of logOpenAIRawStream(failingStream, {
        route: 'official-responses',
        model: 'gpt-5',
      })) {
        // consume the stream
      }
    } catch (error) {
      caught = error
    }
    _flushOpenAIRawStreamLogForTesting()

    expect(caught).toBe(upstreamError)
    const rows = readRows(path)
    expect(rows.map(row => row.lifecycle)).toEqual(['start', 'error'])
    expect(rows[1]).toMatchObject({
      eventCount: 0,
      status: null,
      error: {
        name: 'Error',
        message: 'upstream failure',
        status: 503,
        requestId: 'req-error',
        code: 'server_error',
        type: 'api_error',
        param: 'model',
        incompleteReason: 'server_error',
      },
    })

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

    expect(
      readRows(firstPath)
        .filter(row => row.lifecycle === 'event')
        .map(row => row.event),
    ).toEqual([{ type: 'first' }, { type: 'second' }])
    expect(existsSync(secondPath)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test('shares a writer between overlapping streams', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path })

    const first = logOpenAIRawStream(fromEvents([{ type: 'first' }]), {
      route: 'official-responses',
      model: 'gpt-5',
      streamId: 'first-stream',
    })
    const second = logOpenAIRawStream(fromEvents([{ type: 'second' }]), {
      route: 'chat-completions',
      model: 'deepseek-chat',
      streamId: 'second-stream',
    })

    await first.next()
    await second.next()
    await first.next()
    await second.next()
    _flushOpenAIRawStreamLogForTesting()

    const rows = readRows(path)
    expect(rows.filter(row => row.lifecycle === 'complete')).toHaveLength(2)
    expect(
      rows
        .filter(row => row.lifecycle === 'event')
        .map(row => [row.streamId, row.protocol]),
    ).toEqual([
      ['first-stream', 'responses'],
      ['second-stream', 'chat-completions'],
    ])

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
    logOpenAIRawLifecycle({
      lifecycle: 'retry',
      route: 'official-responses',
      model: 'gpt-5',
      phase: 'request',
      attempt: 1,
      maxRetries: 5,
      delayMs: 500,
      error: new Error('hidden'),
    })

    expect(output[0]).toBe(event)
    expect(existsSync(path)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test('continues when a raw event cannot be serialized', async () => {
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
    _flushOpenAIRawStreamLogForTesting()

    expect(output[0]).toBe(event)
    expect(readRows(path).map(row => row.lifecycle)).toEqual([
      'start',
      'complete',
    ])
    rmSync(root, { recursive: true, force: true })
  })

  test('preserves iterator cleanup when logging fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'blocker')
    _setOpenAIRawStreamLoggerForTesting({
      enabled: true,
      path: join(blocker, 'events.openai.jsonl'),
    })

    let returned = false
    const stream: AsyncIterable<RawEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
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

    rmSync(root, { recursive: true, force: true })
  })
})

describe('logOpenAIRawLifecycle', () => {
  test('logs bounded allowlisted retry diagnostics without sensitive fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({ enabled: true, path })

    logOpenAIRawLifecycle({
      lifecycle: 'retry',
      route: 'official-responses',
      model: 'gpt-5',
      source: 'repl_main_thread',
      streamId: 'stream-retry',
      requestAttempt: 3,
      streamAttempt: 1,
      requestId: 'req-context',
      phase: 'request',
      attempt: 3,
      maxRetries: 5,
      delayMs: 2000,
      error: {
        statusCode: 502,
        request_id: 'req-error',
        authorization: 'Bearer secret-token',
        cookie: 'secret-cookie',
        headers: {
          authorization: 'Bearer nested-secret',
          cookie: 'nested-cookie',
          'set-cookie': 'nested-set-cookie',
        },
        body: 'secret-body',
        request: { payload: 'secret-payload' },
        error: {
          message: 'x'.repeat(700),
          code: 'server_error',
          type: 'api_error',
          param: 'model',
          incomplete_details: { reason: 'server_error' },
        },
      },
    })
    _flushOpenAIRawStreamLogForTesting()

    const rows = readRows(path)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      lifecycle: 'retry',
      phase: 'request',
      attempt: 3,
      maxRetries: 5,
      delayMs: 2000,
      streamId: 'stream-retry',
      requestAttempt: 3,
      streamAttempt: 1,
      requestId: 'req-context',
      error: {
        statusCode: 502,
        requestId: 'req-error',
        code: 'server_error',
        type: 'api_error',
        param: 'model',
        incompleteReason: 'server_error',
      },
    })
    const diagnostics = rows[0]!.error as RawEvent
    expect((diagnostics.message as string).length).toBe(500)
    expect(Object.keys(diagnostics).sort()).toEqual([
      'code',
      'incompleteReason',
      'message',
      'param',
      'requestId',
      'statusCode',
      'type',
    ])
    const serialized = JSON.stringify(rows[0])
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('secret-cookie')
    expect(serialized).not.toContain('nested-secret')
    expect(serialized).not.toContain('nested-set-cookie')
    expect(serialized).not.toContain('secret-body')
    expect(serialized).not.toContain('secret-payload')

    rmSync(root, { recursive: true, force: true })
  })
})

describe('raw stream log caps', () => {
  test('truncates an oversized event payload but keeps the row parseable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({
      enabled: true,
      path,
      maxEntryCodeUnits: 200,
    })

    const fatEvent = { type: 'delta', delta: '中'.repeat(5000) }
    for await (const _event of logOpenAIRawStream(fromEvents([fatEvent]), {
      route: 'chat-completions',
      model: 'grok-4.5',
    })) {
      // Drain the stream so the event row is written.
    }
    _flushOpenAIRawStreamLogForTesting()

    const rows = readRows(path)
    const eventRow = rows.find(row => row.lifecycle === 'event')!
    const logged = eventRow.event as RawEvent
    expect(logged.truncated).toBe(true)
    expect(logged.codeUnits).toBeGreaterThan(5000)
    expect(logged).not.toHaveProperty('bytes')
    expect((logged.preview as string).length).toBe(200)
    // The consumer still receives the untruncated event.
    expect(readFileSync(path, 'utf8')).not.toContain('中'.repeat(1000))

    rmSync(root, { recursive: true, force: true })
  })

  test('stops writing once the file cap is reached and records why', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    _setOpenAIRawStreamLoggerForTesting({
      enabled: true,
      path,
      maxFileBytes: 4096,
    })

    const events = Array.from({ length: 400 }, (_unused, index) => ({
      type: 'delta',
      delta: `chunk-${index}-${'y'.repeat(200)}`,
    }))
    const seen: RawEvent[] = []
    for await (const event of logOpenAIRawStream(fromEvents(events), {
      route: 'chat-completions',
      model: 'grok-4.5',
    })) {
      seen.push(event)
    }
    _flushOpenAIRawStreamLogForTesting()

    // Every event still reaches the caller; only the log stops growing.
    expect(seen.length).toBe(400)
    const rows = readRows(path)
    expect(rows.at(-1)).toMatchObject({
      lifecycle: 'log-capped',
      limitBytes: 4096,
    })
    // No 'complete' row: the cap silences the tail rather than the stream.
    expect(rows.filter(row => row.lifecycle === 'event').length).toBeLessThan(
      400,
    )
    // The crossing batch is written whole, and coalesced batches make it larger
    // than one flush threshold — bounded, not exact.
    const cappedSize = statSync(path).size
    expect(cappedSize).toBeLessThan(4096 + 128 * 1024)

    // A later stream on the same path builds a fresh writer; it must not append.
    for await (const _event of logOpenAIRawStream(fromEvents([events[0]!]), {
      route: 'chat-completions',
      model: 'grok-4.5',
    })) {
      // Drain.
    }
    _flushOpenAIRawStreamLogForTesting()
    expect(statSync(path).size).toBe(cappedSize)

    rmSync(root, { recursive: true, force: true })
  })

  test('marks a resumed file that was already over cap without duplicating the marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openai-raw-log-'))
    const path = join(root, 'events.openai.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify({ lifecycle: 'event', pad: 'z'.repeat(5000) })}\n`,
    )
    _setOpenAIRawStreamLoggerForTesting({
      enabled: true,
      path,
      maxFileBytes: 4096,
    })

    logOpenAIRawLifecycle({
      route: 'chat-completions',
      model: 'grok-4.5',
      lifecycle: 'error',
      phase: 'stream',
      error: new Error('after resume'),
    })
    _flushOpenAIRawStreamLogForTesting()

    const markedSize = statSync(path).size
    expect(
      readRows(path).filter(row => row.lifecycle === 'log-capped'),
    ).toHaveLength(1)

    logOpenAIRawLifecycle({
      route: 'chat-completions',
      model: 'grok-4.5',
      lifecycle: 'error',
      phase: 'stream',
      error: new Error('later event'),
    })
    _flushOpenAIRawStreamLogForTesting()

    expect(statSync(path).size).toBe(markedSize)
    expect(
      readRows(path).filter(row => row.lifecycle === 'log-capped'),
    ).toHaveLength(1)

    rmSync(root, { recursive: true, force: true })
  })
})
