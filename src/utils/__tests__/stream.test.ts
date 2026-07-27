import { describe, expect, test } from 'bun:test'
import { Stream } from '../stream'

describe('Stream', () => {
  test('enqueue then read resolves with the value', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    stream.enqueue(42)
    const result = await stream.next()
    expect(result).toEqual({ done: false, value: 42 })
  })

  test('enqueue multiple then drain in order', async () => {
    const stream = new Stream<string>()
    stream[Symbol.asyncIterator]()
    stream.enqueue('a')
    stream.enqueue('b')
    stream.enqueue('c')
    expect(await stream.next()).toEqual({ done: false, value: 'a' })
    expect(await stream.next()).toEqual({ done: false, value: 'b' })
    expect(await stream.next()).toEqual({ done: false, value: 'c' })
  })

  test('next() blocks until enqueue provides a value', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    const promise = stream.next()
    // Not resolved yet — enqueue after a microtask
    stream.enqueue(99)
    const result = await promise
    expect(result).toEqual({ done: false, value: 99 })
  })

  test('done() resolves pending reader with done:true', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    const promise = stream.next()
    stream.done()
    expect(await promise).toEqual({ done: true, value: undefined })
  })

  test('done() with no pending reader — subsequent next returns done:true', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    stream.done()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  test('error() rejects pending reader', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    const promise = stream.next()
    stream.error(new Error('boom'))
    expect(promise).rejects.toThrow('boom')
  })

  test('error() after done — error wins over done', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    stream.done()
    stream.error(new Error('late error'))
    // next() checks hasError before isDone, so a reported error is never dropped
    expect(stream.next()).rejects.toThrow('late error')
  })

  test('error() then done() with a buffered value — queue drains, then the error surfaces', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    // Producer shape of streamedCheckPermissionsAndCallTool:
    // .catch(e => stream.error(e)).finally(() => stream.done()) — same
    // microtask, no consumer read in between, and a progress value still queued.
    stream.enqueue(1)
    stream.error(new Error('tool failed'))
    stream.done()
    // Buffered progress is still delivered first.
    expect(await stream.next()).toEqual({ done: false, value: 1 })
    // Then the error, rather than a silent done:true that would leave the
    // tool_use block without a tool_result.
    expect(stream.next()).rejects.toThrow('tool failed')
  })

  test('error() with a falsy rejection value still rejects', async () => {
    // toolExecution.ts forwards whatever the promise rejected with, and
    // `throw undefined` is legal. When the flag and the value shared one field,
    // this surfaced as a clean done:true — the dropped-tool_result case the
    // error-before-done ordering exists to prevent.
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    stream.error(undefined)
    stream.done()
    expect(stream.next()).rejects.toBeUndefined()
  })

  test('error() with other falsy values rejects with the value unchanged', async () => {
    for (const falsy of [null, 0, '', false, Number.NaN]) {
      const stream = new Stream<number>()
      stream[Symbol.asyncIterator]()
      stream.error(falsy)
      stream.done()
      let rejected = false
      let received: unknown = 'not-called'
      await stream.next().catch(e => {
        rejected = true
        received = e
      })
      expect(rejected).toBe(true)
      // Not wrapped or coerced — the original rejection reaches the consumer.
      expect(received).toBe(falsy)
    }
  })

  test('enqueue after done — queue is checked before isDone, value is consumed', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    stream.done()
    stream.enqueue(1)
    // next() checks queue.length > 0 first, so enqueued value is returned
    expect(await stream.next()).toEqual({ done: false, value: 1 })
    // After draining queue, done takes effect
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  test('return() marks stream as done and calls returned callback', async () => {
    let called = false
    const stream = new Stream<number>(() => {
      called = true
    })
    stream[Symbol.asyncIterator]()
    const result = await stream.return()
    expect(result).toEqual({ done: true, value: undefined })
    expect(called).toBe(true)
    // Subsequent next returns done
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  test('return() without callback still works', async () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    const result = await stream.return()
    expect(result).toEqual({ done: true, value: undefined })
  })

  test('Symbol.asyncIterator throws on second call', () => {
    const stream = new Stream<number>()
    stream[Symbol.asyncIterator]()
    expect(() => stream[Symbol.asyncIterator]()).toThrow(
      'Stream can only be iterated once',
    )
  })

  test('for-await-of iteration drains queued values then ends', async () => {
    const stream = new Stream<string>()
    stream.enqueue('x')
    stream.enqueue('y')
    stream.done()
    const results: string[] = []
    for await (const value of stream) {
      results.push(value)
    }
    expect(results).toEqual(['x', 'y'])
  })

  test('for-await-of blocks until done', async () => {
    const stream = new Stream<number>()
    const results: number[] = []

    const iterPromise = (async () => {
      for await (const v of stream) {
        results.push(v)
      }
    })()

    // Enqueue after a tick
    await Promise.resolve()
    stream.enqueue(1)
    stream.enqueue(2)
    stream.done()

    await iterPromise
    expect(results).toEqual([1, 2])
  })

  test('error during for-await-of rejects the loop', async () => {
    const stream = new Stream<number>()
    const iterPromise = (async () => {
      for await (const _ of stream) {
        // will error before any value
      }
    })()
    stream.error(new Error('stream broken'))
    expect(iterPromise).rejects.toThrow('stream broken')
  })

  test('concurrent enqueue from multiple sources does not lose data', async () => {
    const stream = new Stream<number>()
    // Rapid sequential enqueue
    for (let i = 0; i < 100; i++) {
      stream.enqueue(i)
    }
    stream.done()

    const results: number[] = []
    for await (const v of stream) {
      results.push(v)
    }
    expect(results.length).toBe(100)
    expect(results[0]).toBe(0)
    expect(results[99]).toBe(99)
  })
})
