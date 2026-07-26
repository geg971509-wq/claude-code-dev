import { writeSync } from 'node:fs'

function handleEPIPE(
  stream: NodeJS.WriteStream,
): (err: NodeJS.ErrnoException) => void {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      stream.destroy()
    }
  }
}

// Prevents memory leak when pipe is broken (e.g., `claude -p | head -1`)
export function registerProcessOutputErrorHandlers(): void {
  process.stdout.on('error', handleEPIPE(process.stdout))
  process.stderr.on('error', handleEPIPE(process.stderr))
}

/**
 * Returns false when the write was buffered rather than accepted, i.e. the
 * caller should await {@link waitForOutputDrain} before exiting the process.
 * Returns true when there is nothing to wait for (accepted, or the stream is
 * already gone).
 */
function writeOut(stream: NodeJS.WriteStream, data: string): boolean {
  if (stream.destroyed) {
    return true
  }

  const accepted = stream.write(data)
  if (!accepted && !pendingDrain.has(stream)) {
    pendingDrain.add(stream)
    // Clear on the real event, not only when someone awaits. Callers that
    // ignore the return value would otherwise leave the flag set forever, and a
    // later unconditional waitForOutputDrain would block for its full timeout
    // waiting on a 'drain' that already fired.
    const clear = () => {
      pendingDrain.delete(stream)
      stream.removeListener('drain', clear)
      stream.removeListener('error', clear)
      stream.removeListener('close', clear)
    }
    stream.once('drain', clear)
    stream.once('error', clear)
    stream.once('close', clear)
  }
  return accepted
}

export function writeToStdout(data: string): boolean {
  return writeOut(process.stdout, data)
}

/**
 * Write to stdout so the data survives an immediate process.exit().
 *
 * For synchronous exit paths, which cannot await {@link waitForOutputDrain}.
 * process.exit() discards the stream's buffer, and on a pipe that buffer starts
 * at exactly one page: measured on Bun, `stream.write` + same-tick exit delivers
 * 65536 bytes of *any* larger payload — 65536 of 8MB — with no error on either
 * side. A blocking fd-1 write instead returns only once the OS has taken every
 * byte, so there is nothing left to discard.
 *
 * Blocking is the right trade here specifically because the caller is exiting:
 * there is no throughput left to protect, and stalling until a slow reader
 * catches up beats silently truncating. Do NOT use this on streaming paths —
 * measured 60µs/write against a slow consumer versus 0.7µs through the stream.
 */
export function writeToStdoutBeforeExit(data: string): void {
  if (process.stdout.destroyed) {
    return
  }

  // A prior oversized write is still sitting in the stream's buffer. Bypassing
  // it with a direct fd write would emit this data *ahead* of it, and the buffer
  // cannot be flushed synchronously — draining needs the event loop, which a
  // blocking write would deny. Keep ordering by staying on the stream; that is
  // the pre-existing behaviour, so this is no worse than before.
  if (pendingDrain.has(process.stdout)) {
    writeOut(process.stdout, data)
    return
  }

  const buf = Buffer.from(data, 'utf8')
  let offset = 0
  while (offset < buf.length) {
    try {
      offset += writeSync(1, buf, offset, buf.length - offset)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // Non-blocking fd (platform/runtime dependent) — retry rather than lose
      // the tail.
      if (code === 'EAGAIN') continue
      // Reader is gone (`claude -p | head -1`). Nothing to deliver to.
      if (code === 'EPIPE') return
      throw e
    }
  }
}

export function writeToStderr(data: string): boolean {
  return writeOut(process.stderr, data)
}

/**
 * Streams whose last write was buffered rather than accepted.
 *
 * The returned boolean from write() is the ONLY reliable backpressure signal on
 * Bun: for an 8MB write to a pipe Bun reports `write() === false` while
 * `writableLength === 0` and `writableNeedDrain === false` (Node reports
 * 8388609 / true for the same write). So neither property can gate the wait —
 * we have to remember what write() told us.
 */
const pendingDrain = new WeakSet<NodeJS.WriteStream>()

/**
 * Wait until a stream that reported backpressure has flushed.
 *
 * Needed because process.exit() discards whatever has not reached the OS. When
 * stdout is a pipe the kernel buffer is a single page (64KB on macOS), so a
 * multi-megabyte `-p --output-format json` result is still in flight when
 * write() returns — measured on Bun, exiting immediately delivers exactly 65536
 * bytes of an 8MB document, with no error on either side.
 *
 * No-ops unless the last write was buffered, so an unconditional call on a
 * quiet stream costs nothing. Resolves (never rejects) on 'error'/'close' too:
 * a stream torn down by EPIPE (`claude -p | head -1`) never emits 'drain', and
 * the intent here is "stop waiting", not "handle the failure".
 */
export function waitForOutputDrain(
  stream: NodeJS.WriteStream,
  timeoutMs = 5_000,
): Promise<void> {
  if (!pendingDrain.has(stream)) {
    return Promise.resolve()
  }
  pendingDrain.delete(stream)
  if (stream.destroyed) {
    return Promise.resolve()
  }

  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer)
      stream.removeListener('drain', done)
      stream.removeListener('error', done)
      stream.removeListener('close', done)
      resolve()
    }
    // Bounded so a stalled reader cannot hang shutdown indefinitely.
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
    stream.once('drain', done)
    stream.once('error', done)
    stream.once('close', done)
  })
}

export function waitForStdoutDrain(timeoutMs?: number): Promise<void> {
  return waitForOutputDrain(process.stdout, timeoutMs)
}

// Write error to stderr and exit with code 1. Consolidates the
// console.error + process.exit(1) pattern used in entrypoint fast-paths.
export function exitWithError(message: string): never {
  console.error(message)
  process.exit(1)
}

// Wait for a stdin-like stream to close, but give up after ms if no data ever
// arrives. First data chunk cancels the timeout — after that, wait for end
// unconditionally (caller's accumulator needs all chunks, not just the first).
// Returns true on timeout, false on end. Used by -p mode to distinguish a
// real pipe producer from an inherited-but-idle parent stdin.
export function peekForStdinData(
  stream: NodeJS.EventEmitter,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const done = (timedOut: boolean) => {
      clearTimeout(peek)
      stream.off('end', onEnd)
      stream.off('data', onFirstData)
      void resolve(timedOut)
    }
    const onEnd = () => done(false)
    const onFirstData = () => clearTimeout(peek)
    // eslint-disable-next-line no-restricted-syntax -- not a sleep: races timeout against stream end/data events
    const peek = setTimeout(done, ms, true)
    stream.once('end', onEnd)
    stream.once('data', onFirstData)
  })
}
