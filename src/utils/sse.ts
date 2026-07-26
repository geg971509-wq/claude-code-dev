/**
 * SSE (Server-Sent Events) frame parser.
 * Zero dependencies — safe to import from any layer.
 */

export interface SSEFrame {
  event?: string
  id?: string
  data?: string
}

/**
 * Incrementally parse SSE frames from a text buffer.
 * Returns parsed frames and the remaining (incomplete) buffer.
 *
 * @internal exported for testing and reuse across providers/transports
 */
export function parseSSEFrames(buffer: string): {
  frames: SSEFrame[]
  remaining: string
} {
  const frames: SSEFrame[] = []
  let pos = 0

  // SSE frames are delimited by an empty line. Support LF and CRLF streams.
  const frameDelimiter = /\r?\n\r?\n/g
  frameDelimiter.lastIndex = pos

  let delimiterMatch: RegExpExecArray | null
  while ((delimiterMatch = frameDelimiter.exec(buffer)) !== null) {
    const frameEnd = delimiterMatch.index
    const rawFrame = buffer.slice(pos, frameEnd)
    pos = frameEnd + delimiterMatch[0].length

    // Skip empty frames
    if (!rawFrame.trim()) continue

    const frame: SSEFrame = {}
    let isComment = false

    for (const rawLine of rawFrame.split('\n')) {
      // Normalize CRLF lines in mixed-line-ending streams.
      const line =
        rawLine[rawLine.length - 1] === '\r' ? rawLine.slice(0, -1) : rawLine

      if (line.startsWith(':')) {
        // SSE comment (e.g., `:keepalive`)
        isComment = true
        continue
      }

      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue

      const field = line.slice(0, colonIdx)
      // Per SSE spec, strip one leading space after colon if present
      const value =
        line[colonIdx + 1] === ' '
          ? line.slice(colonIdx + 2)
          : line.slice(colonIdx + 1)

      switch (field) {
        case 'event':
          frame.event = value
          break
        case 'id':
          frame.id = value
          break
        case 'data':
          // Per SSE spec, multiple data: lines are concatenated with \n
          frame.data = frame.data ? frame.data + '\n' + value : value
          break
        // Ignore other fields (retry:, etc.)
      }
    }

    // Only emit frames that have data (or are pure comments which reset liveness)
    if (frame.data || isComment) {
      frames.push(frame)
    }
  }

  return { frames, remaining: buffer.slice(pos) }
}
