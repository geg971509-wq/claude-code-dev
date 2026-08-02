/**
 * First test for /compact's entry point. Covers only what is reachable without
 * mocks: the empty-message guard, and the catch's two-way branch between
 * cancel and wrap. The happy path needs a real model call, so
 * compactConversation's body stays uncovered here — as does the concurrent
 * microcompact/cache-param Promise.all, which sits past the tripwire below.
 *
 * No mock.module on purpose. services/compact/compact.js has 25 exports and
 * mock.module is process-global in bun, so partial-mocking it would break
 * sibling suites rather than only this file.
 *
 * This file mocks nothing and is still vulnerable to the reverse: if it dies
 * with `SyntaxError: Export named '<something>' not found`, that is a partial
 * mock in a file loaded earlier, not a compaction bug. Measured: of the 9 files
 * that mock.module bootstrap/state, exactly 1 (LocalAgentTask.test.ts) kills
 * this one. Fixing it there is not a one-liner — bootstrap/state has 207
 * exports, and spreading the real module past that point just surfaces the next
 * partially-mocked module (utils/task/diskOutput). Left alone deliberately;
 * effectiveWindow.test.ts carries the same exposure.
 */
import { describe, expect, test } from 'bun:test'
import type { LocalJSXCommandContext } from '../../../types/command'
import type { Message } from '../../../types/message'
import { call } from '../compact'

const SENTINEL = 'sentinel: getAppState reached'

function contextWith(
  messages: Message[],
  aborted: boolean,
): LocalJSXCommandContext {
  const abortController = new AbortController()
  if (aborted) abortController.abort()
  return {
    abortController,
    messages,
    agentId: undefined,
    options: {},
    // Throws rather than returning a stub. An aborted signal does NOT
    // short-circuit this function: trySessionMemoryCompaction returns falsy and
    // execution runs on into getCacheSharingParams. This is the tripwire that
    // keeps the run off the network — a plausible-looking `() => ({})` stub
    // instead dies on a TypeError deep inside the same call, which reads as the
    // test working while actually testing an accident.
    getAppState: () => {
      throw new Error(SENTINEL)
    },
  } as unknown as LocalJSXCommandContext
}

const userMessage = {
  type: 'user',
  uuid: 'u1',
  message: { role: 'user', content: 'hi' },
} as unknown as Message

describe('/compact call', () => {
  // Guard sits outside the try, so it beats every other failure mode —
  // including an already-aborted signal.
  test('rejects an empty conversation before doing any work', async () => {
    await expect(call('', contextWith([], false))).rejects.toThrow(
      'No messages to compact',
    )
  })

  // These two are one test split in half: identical input, only the signal
  // differs. Apart they prove nothing — the cancel case alone stays green if
  // the catch is rewritten to return 'Compaction canceled.' for everything,
  // and the wrap case alone stays green if the abort branch is deleted.
  test('translates an aborted run into a cancel', async () => {
    await expect(call('', contextWith([userMessage], true))).rejects.toThrow(
      'Compaction canceled.',
    )
  })

  test('wraps a non-aborted failure with the compaction prefix', async () => {
    // `Error: ` prefix included deliberately: the catch interpolates the Error
    // object, not its message, so this pins the user-visible string as shipped.
    const promise = call('', contextWith([userMessage], false))
    await expect(promise).rejects.toThrow(
      `Error during compaction: Error: ${SENTINEL}`,
    )
  })
})
