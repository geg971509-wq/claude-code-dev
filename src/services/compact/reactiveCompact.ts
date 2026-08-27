import { feature } from 'bun:bundle'
import { getSessionId } from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  isMediaSizeErrorMessage,
  isPromptTooLongMessage,
} from '../api/errors.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  type CompactionResult,
  compactConversation,
  emitCompactionState,
} from './compact.js'
import {
  isColdCompactEnabled,
  isCompactBlockedByHookError,
} from './autoCompact.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import {
  getPrecomputedCompactManager,
  mergePrecomputedResult,
} from './precomputedCompact.js'

export type ReactiveCompactResult = {
  result: CompactionResult
  precomputed: boolean
}

export const isReactiveCompactEnabled: () => boolean = () => {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  return true
}

export const isWithheldPromptTooLong: (message: Message) => boolean =
  message => {
    if (message.type !== 'assistant' || !message.isApiErrorMessage) return false
    return isPromptTooLongMessage(message as AssistantMessage)
  }

export const isWithheldMediaSizeError: (message: Message) => boolean =
  message => {
    if (message.type !== 'assistant' || !message.isApiErrorMessage) return false
    return isMediaSizeErrorMessage(message as AssistantMessage)
  }

export const tryReactiveCompact: (params: {
  hasAttempted: boolean
  querySource: string
  aborted: boolean
  messages: Message[]
  cacheSafeParams: Record<string, unknown>
}) => Promise<ReactiveCompactResult | null> = async ({
  hasAttempted,
  querySource,
  aborted,
  messages,
  cacheSafeParams,
}) => {
  if (hasAttempted || aborted) return null
  const params = cacheSafeParams as unknown as CacheSafeParams
  const cold = isColdCompactEnabled()
  try {
    const context = params.toolUseContext
    let precomputed
    let compactStartAlreadyEmitted = false
    const manager =
      context.precomputedCompactManager ??
      (feature('PRECOMPUTED_COMPACT')
        ? getPrecomputedCompactManager(getSessionId())
        : undefined)
    if (manager) {
      const key = context.agentId ?? 'main'
      const model = context.options.mainLoopModel
      await manager.rehydrate(model, messages, {
        onTransition: event => emitCompactionState(context, event),
      })
      compactStartAlreadyEmitted = manager.get(key)?.status === 'pending'
      if (compactStartAlreadyEmitted) {
        context.onCompactProgress?.({ type: 'compact_start' })
        context.setSDKStatus?.('compacting')
      }
      const entry = await manager.consume(
        key,
        model,
        messages,
        Date.now(),
        context.abortController.signal,
      )
      if (context.abortController.signal.aborted) {
        if (compactStartAlreadyEmitted) {
          context.onCompactProgress?.({ type: 'compact_end' })
          context.setSDKStatus?.('')
        }
        return null
      }
      if (entry) precomputed = mergePrecomputedResult(entry, messages)
    }
    const result = await compactConversation(
      messages,
      context,
      params,
      true,
      undefined,
      true,
      {
        isRecompactionInChain: false,
        turnsSincePreviousCompact: 0,
        autoCompactThreshold: 0,
      },
      {
        ...(cold && { stripNonEssential: true }),
        ...(precomputed && { precomputed }),
        compactStartAlreadyEmitted,
      },
    )
    runPostCompactCleanup(context.options.querySource)
    return { result, precomputed: precomputed !== undefined }
  } catch (error) {
    // PreCompact decision=block is not a compact failure — same as autoCompact.
    if (isCompactBlockedByHookError(error)) {
      logForDebugging(
        `reactiveCompact: blocked by PreCompact hook — ${error instanceof Error ? error.message : String(error)}`,
        { level: 'warn' },
      )
      return null
    }
    logForDebugging(
      `reactiveCompact: emergency compaction failed — ${String(error)}`,
      { level: 'warn' },
    )
    logError(error)
    return null
  }
}
