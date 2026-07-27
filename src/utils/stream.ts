export class Stream<T> implements AsyncIterator<T> {
  private readonly queue: T[] = []
  private readResolve?: (value: IteratorResult<T>) => void
  private readReject?: (error: unknown) => void
  private isDone: boolean = false
  // Flag and value kept separate: a rejection value is whatever the producer
  // was handed, and `throw undefined` is legal. One field doing both jobs meant
  // `if (this.hasError)` read a falsy rejection as "no error" and handed the
  // consumer a clean `done` — the exact dropped-tool_result case below.
  private hasError = false
  private errorValue: unknown
  private started = false

  constructor(private readonly returned?: () => void) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.started) {
      throw new Error('Stream can only be iterated once')
    }
    this.started = true
    return this
  }

  next(): Promise<IteratorResult<T, unknown>> {
    if (this.queue.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.queue.shift()!,
      })
    }
    // Error before done: a producer that calls error() then done() in the same
    // microtask stores the error (no pending readReject to hand it to) and then
    // sets isDone. Checking isDone first would drop that error, leaving the
    // tool_use block without a tool_result. Queue still drains first so buffered
    // progress is delivered either way.
    if (this.hasError) {
      return Promise.reject(this.errorValue)
    }
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.readResolve = resolve
      this.readReject = reject
    })
  }

  enqueue(value: T): void {
    if (this.readResolve) {
      const resolve = this.readResolve
      this.readResolve = undefined
      this.readReject = undefined
      resolve({ done: false, value })
    } else {
      this.queue.push(value)
    }
  }

  done() {
    this.isDone = true
    if (this.readResolve) {
      const resolve = this.readResolve
      this.readResolve = undefined
      this.readReject = undefined
      resolve({ done: true, value: undefined })
    }
  }

  /**
   * Signal an error to the consumer.
   *
   * Behavior: If a consumer is waiting (readReject exists), the error is delivered
   * immediately. Otherwise, the error is stored and will be thrown on the next
   * next() call. The producer MUST call done() after error() to properly close
   * the stream — calling error() alone leaves the stream in a half-open state.
   *
   * Typical usage:
   *   stream.error(err)
   *   stream.done()
   */
  error(error: unknown) {
    this.hasError = true
    this.errorValue = error
    if (this.readReject) {
      const reject = this.readReject
      this.readResolve = undefined
      this.readReject = undefined
      reject(error)
    }
  }

  return(): Promise<IteratorResult<T, unknown>> {
    this.isDone = true
    if (this.returned) {
      this.returned()
    }
    return Promise.resolve({ done: true, value: undefined })
  }
}
