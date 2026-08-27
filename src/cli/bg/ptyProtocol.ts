export type PtyHostMessage =
  | { type: 'auth'; token: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill'; signal?: 'SIGTERM' | 'SIGKILL' }
  | { type: 'ping' }

export type PtyHostEvent =
  | { type: 'live'; sessionId: string }
  | { type: 'data'; data: string }
  | { type: 'pong' }
  | { type: 'exit'; code: number | null; signal: string | null }

export function isPtyHostMessage(value: unknown): value is PtyHostMessage {
  if (typeof value !== 'object' || value === null || !('type' in value))
    return false
  switch (value.type) {
    case 'auth':
      return (
        'token' in value &&
        typeof value.token === 'string' &&
        value.token.length <= 256
      )
    case 'input':
      return (
        'data' in value &&
        typeof value.data === 'string' &&
        value.data.length <= 1_048_576
      )
    case 'resize':
      return (
        'cols' in value &&
        'rows' in value &&
        Number.isInteger(value.cols) &&
        Number.isInteger(value.rows) &&
        Number(value.cols) >= 1 &&
        Number(value.cols) <= 1_000 &&
        Number(value.rows) >= 1 &&
        Number(value.rows) <= 1_000
      )
    case 'kill':
      return (
        !('signal' in value) ||
        value.signal === undefined ||
        value.signal === 'SIGTERM' ||
        value.signal === 'SIGKILL'
      )
    case 'ping':
      return true
    default:
      return false
  }
}

export function isPtyHostEvent(value: unknown): value is PtyHostEvent {
  if (typeof value !== 'object' || value === null || !('type' in value))
    return false
  switch (value.type) {
    case 'live':
      return 'sessionId' in value && typeof value.sessionId === 'string'
    case 'data':
      return 'data' in value && typeof value.data === 'string'
    case 'pong':
      return true
    case 'exit':
      return (
        'code' in value &&
        'signal' in value &&
        (value.code === null || typeof value.code === 'number') &&
        (value.signal === null || typeof value.signal === 'string')
      )
    default:
      return false
  }
}
