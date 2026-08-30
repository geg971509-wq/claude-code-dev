import { describe, expect, test } from 'bun:test'
import {
  applyCodexIdentityHeaders,
  buildCodexClientMetadata,
  CODEX_CLIENT_REQUEST_ID_HEADER,
  CODEX_INSTALLATION_ID_METADATA_KEY,
  CODEX_SESSION_ID_HEADER,
  CODEX_THREAD_ID_HEADER,
  CODEX_WINDOW_ID_HEADER,
  createCodexRequestIdentity,
} from '../requestMetadata.js'

describe('Codex Responses request identity', () => {
  test('builds canonical client metadata', () => {
    const identity = createCodexRequestIdentity({
      sessionId: 'session-1',
      installationId: 'installation-1',
    })

    expect(identity).toEqual({
      installationId: 'installation-1',
      sessionId: 'session-1',
      threadId: 'session-1',
      windowId: 'session-1:0',
    })
    expect(buildCodexClientMetadata(identity)).toEqual({
      [CODEX_INSTALLATION_ID_METADATA_KEY]: 'installation-1',
      session_id: 'session-1',
      thread_id: 'session-1',
      [CODEX_WINDOW_ID_HEADER]: 'session-1:0',
    })
  })

  test('projects compatibility headers without replacing explicit values', () => {
    const identity = createCodexRequestIdentity({
      sessionId: 'session-1',
      threadId: 'thread-1',
      windowNumber: 2,
    })
    const headers = new Headers({
      [CODEX_SESSION_ID_HEADER]: 'caller-session',
    })

    applyCodexIdentityHeaders(headers, identity)

    expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe('caller-session')
    expect(headers.get(CODEX_THREAD_ID_HEADER)).toBe('thread-1')
    expect(headers.get(CODEX_CLIENT_REQUEST_ID_HEADER)).toBe('thread-1')
    expect(headers.get(CODEX_WINDOW_ID_HEADER)).toBe('thread-1:2')
  })

  test('omits installation metadata when no stable identifier is available', () => {
    const metadata = buildCodexClientMetadata(
      createCodexRequestIdentity({ sessionId: 'session-1' }),
    )

    expect(metadata[CODEX_INSTALLATION_ID_METADATA_KEY]).toBeUndefined()
  })
})
