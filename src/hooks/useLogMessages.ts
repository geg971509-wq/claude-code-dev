import type { UUID } from 'crypto'
import { useEffect, useRef } from 'react'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { logError } from '../utils/log.js'
import {
  memoryDebugAdd,
  memoryDebugEvent,
  memoryDebugSet,
} from '../utils/memoryDebug.js'
import {
  cleanMessagesForLogging,
  isChainParticipant,
  recordTranscript,
} from '../utils/sessionStorage.js'

type TranscriptWriteRequest = {
  slice: Message[]
  allMessages: readonly Message[]
  teamInfo: { teamName?: string; agentName?: string }
  parentHint?: UUID
  isIncremental: boolean
  sequence: number
}

/**
 * Hook that logs messages to the transcript
 * conversation ID that only changes when a new conversation is started.
 *
 * @param messages The current conversation messages
 * @param ignore When true, messages will not be recorded to the transcript
 */
export function useLogMessages(messages: Message[], ignore: boolean = false) {
  const teamContext = useAppState(s => s.teamContext)

  // messages is append-only between compactions, so track where we left off
  // and only pass the new tail to recordTranscript. Avoids O(n) filter+scan
  // on every setMessages (~20x/turn, so n=3000 was ~120k wasted iterations).
  const lastRecordedLengthRef = useRef(0)
  const lastParentUuidRef = useRef<UUID | undefined>(undefined)
  // First-uuid change = compaction or /clear rebuilt the array; length alone
  // can't detect this since post-compact [CB,summary,...keep,new] may be longer.
  const firstMessageUuidRef = useRef<UUID | undefined>(undefined)
  // Guard against stale async .then() overwriting a fresher sync update when
  // an incremental render fires before the compaction .then() resolves.
  const callSeqRef = useRef(0)
  // A resumed transcript can contain megabytes of tool results per message.
  // Keep at most one active write and one latest pending snapshot; starting a
  // write for every streaming state update retains the whole history per call.
  const pendingWriteRef = useRef<TranscriptWriteRequest | null>(null)
  const writeActiveRef = useRef(false)

  function drainTranscriptWrites(): void {
    if (writeActiveRef.current) return
    writeActiveRef.current = true
    memoryDebugSet('transcriptWriteActive', 1)
    void (async () => {
      try {
        while (pendingWriteRef.current !== null) {
          const request = pendingWriteRef.current
          pendingWriteRef.current = null
          memoryDebugSet('transcriptPending', 0)
          memoryDebugAdd('transcriptWriteStarts')
          memoryDebugEvent('transcript_write_start', {
            sliceLength: request.slice.length,
            allMessagesLength: request.allMessages.length,
            incremental: request.isIncremental,
          })
          try {
            const lastRecordedUuid = await recordTranscript(
              request.slice,
              request.teamInfo,
              request.parentHint ?? lastParentUuidRef.current,
              request.allMessages,
            )
            if (
              request.sequence === callSeqRef.current &&
              lastRecordedUuid &&
              !request.isIncremental
            ) {
              lastParentUuidRef.current = lastRecordedUuid
            }
            memoryDebugEvent('transcript_write_done', {
              sliceLength: request.slice.length,
              incremental: request.isIncremental,
            })
          } catch (error) {
            logError(error)
            memoryDebugEvent('transcript_write_error')
          }
        }
      } finally {
        writeActiveRef.current = false
        memoryDebugSet('transcriptWriteActive', 0)
        if (pendingWriteRef.current !== null) drainTranscriptWrites()
      }
    })()
  }

  useEffect(() => {
    if (ignore) return

    const currentFirstUuid = messages[0]?.uuid as UUID | undefined
    const prevLength = lastRecordedLengthRef.current

    // First-render: firstMessageUuidRef is undefined. Compaction: first uuid changes.
    // Both are !isIncremental, but first-render sync-walk is safe (no messagesToKeep).
    const wasFirstRender = firstMessageUuidRef.current === undefined
    const isIncremental =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current &&
      prevLength <= messages.length
    // Same-head shrink: tombstone filter, rewind, snip, partial-compact.
    // Distinguished from compaction (first uuid changes) because the tail
    // is either an existing on-disk message or a fresh message that this
    // same effect's recordTranscript(fullArray) will write — see sync-walk
    // guard below.
    const isSameHeadShrink =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current &&
      prevLength > messages.length

    const startIndex = isIncremental ? prevLength : 0
    if (startIndex === messages.length) return

    // Full array on first call + after compaction: recordTranscript's own
    // O(n) dedup loop handles messagesToKeep interleaving correctly there.
    const slice = startIndex === 0 ? messages : messages.slice(startIndex)
    const parentHint = isIncremental ? lastParentUuidRef.current : undefined

    const seq = ++callSeqRef.current
    memoryDebugAdd('transcriptEffectCount')
    memoryDebugSet('transcriptLastMessagesLength', messages.length)
    memoryDebugSet('transcriptLastSliceLength', slice.length)
    pendingWriteRef.current = {
      slice,
      allMessages: messages,
      teamInfo: isAgentSwarmsEnabled()
        ? {
            teamName: teamContext?.teamName,
            agentName: teamContext?.selfAgentName,
          }
        : {},
      parentHint,
      isIncremental,
      sequence: seq,
    }
    memoryDebugSet('transcriptPending', 1)
    drainTranscriptWrites()

    // Sync-walk safe for: incremental (pure new-tail slice), first-render
    // (no messagesToKeep interleaving), and same-head shrink. Shrink is the
    // subtle one: the picked uuid is either already on disk (tombstone/rewind
    // — survivors were written before) or is being written by THIS effect's
    // recordTranscript(fullArray) call (snip boundary / partial-compact tail
    // — enqueueWrite ordering guarantees it lands before any later write that
    // chains to it). Without this, the ref stays stale at a tombstoned uuid:
    // the async .then() correction is raced out by the next effect's seq bump
    // on large sessions where recordTranscript(fullArray) is slow. Only the
    // compaction case (first uuid changed) remains unsafe — tail may be
    // messagesToKeep whose last-actually-recorded uuid differs.
    if (isIncremental || wasFirstRender || isSameHeadShrink) {
      // Match EXACTLY what recordTranscript persists: cleanMessagesForLogging
      // applies both the isLoggableMessage filter and (for external users) the
      // REPL-strip + isVirtual-promote transform. Using the raw predicate here
      // would pick a UUID that the transform drops, leaving the parent hint
      // pointing at a message that never reached disk. Pass full messages as
      // replId context — REPL tool_use and its tool_result land in separate
      // render cycles, so the slice alone can't pair them.
      const last = cleanMessagesForLogging(slice, messages).findLast(
        isChainParticipant,
      )
      if (last) lastParentUuidRef.current = last.uuid as UUID
    }

    lastRecordedLengthRef.current = messages.length
    firstMessageUuidRef.current = currentFirstUuid
  }, [messages, ignore, teamContext?.teamName, teamContext?.selfAgentName])
}
