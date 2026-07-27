const NO_VALUE = Symbol('NO_VALUE')

export async function lastX<A>(as: AsyncGenerator<A>): Promise<A> {
  let lastValue: A | typeof NO_VALUE = NO_VALUE
  for await (const a of as) {
    lastValue = a
  }
  if (lastValue === NO_VALUE) {
    throw new Error('No items in generator')
  }
  return lastValue
}

export async function returnValue<A>(
  as: AsyncGenerator<unknown, A>,
): Promise<A> {
  let e
  do {
    e = await as.next()
  } while (!e.done)
  return e.value
}

type QueuedGenerator<A> = {
  // biome-ignore lint/suspicious/noConfusingVoidType: void matches AsyncGenerator<A, void> return type
  done: boolean | void
  // biome-ignore lint/suspicious/noConfusingVoidType: void matches AsyncGenerator<A, void> yield type
  value: A | void
  generator: AsyncGenerator<A, void>
  promise: Promise<QueuedGenerator<A>>
}

// Run all generators concurrently up to a concurrency cap, yielding values as they come in
export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  const next = (generator: AsyncGenerator<A, void>) => {
    const promise: Promise<QueuedGenerator<A>> = generator
      .next()
      .then(({ done, value }) => ({
        done,
        value,
        generator,
        promise,
      }))
    return promise
  }
  const waiting = [...generators]
  const promises = new Set<Promise<QueuedGenerator<A>>>()
  // Generators that have been started and have not reported done. Needed so an
  // abandoned `all()` can settle them: a suspended generator's `finally` only
  // runs if something calls `.return()` on it, and dropping the reference is not
  // enough. Tracked separately from `promises`, which holds the wrapper promise.
  const started = new Set<AsyncGenerator<A, void>>()

  const start = (generator: AsyncGenerator<A, void>) => {
    started.add(generator)
    promises.add(next(generator))
  }

  try {
    // Start initial batch up to concurrency cap
    while (promises.size < concurrencyCap && waiting.length > 0) {
      start(waiting.shift()!)
    }

    while (promises.size > 0) {
      const { done, value, generator, promise } = await Promise.race(promises)
      promises.delete(promise)

      if (!done) {
        promises.add(next(generator))
        // TODO: Clean this up
        if (value !== undefined) {
          yield value as Awaited<A>
        }
      } else {
        started.delete(generator)
        if (waiting.length > 0) {
          // Start a new generator when one finishes
          start(waiting.shift()!)
        }
      }
    }
  } finally {
    // Ask each unfinished generator to unwind when the consumer abandons us
    // (REPL interrupt). Dropping the reference is not enough: a suspended
    // generator's `finally` runs only if something calls `.return()` on it.
    //
    // How much this settles depends on where the generator is parked, and it is
    // less than it looks:
    //   parked at a `yield` → its `finally` runs promptly.
    //   parked mid-`await`  → `.return()` queues behind the in-flight step, so
    //                         the `finally` runs whenever that settles. No
    //                         bound, and `all()` has long since returned.
    // Deliberately not awaited: awaiting would let one slow teardown stall the
    // interrupt path this exists to keep responsive. So treat this as a
    // best-effort nudge, not a barrier — anything that must be settled by the
    // time the turn ends needs its own turn-boundary reset (see
    // resetLoadingState in REPL.tsx for the in-progress tool ids).
    for (const generator of started) {
      void generator.return(undefined).catch(() => {})
    }
    started.clear()
  }
}

export async function toArray<A>(
  generator: AsyncGenerator<A, void>,
): Promise<A[]> {
  const result: A[] = []
  for await (const a of generator) {
    result.push(a)
  }
  return result
}

export async function* fromArray<T>(values: T[]): AsyncGenerator<T, void> {
  for (const value of values) {
    yield value
  }
}
