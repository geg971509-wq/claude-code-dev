import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  isMediaSizeErrorMessage,
  isPromptTooLongMessage,
} from '../api/errors.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { type CompactionResult, compactConversation } from './compact.js'
import {
  isColdCompactEnabled,
  isCompactBlockedByHookError,
} from './autoCompact.js'
import { logError } from '../../utils/log.js'
import { logForDebugging } from '../../utils/debug.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'

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
}) => Promise<CompactionResult | null> = async ({
  hasAttempted,
  aborted,
  messages,
  cacheSafeParams,
}) => {
  if (hasAttempted || aborted) return null
  const params = cacheSafeParams as unknown as CacheSafeParams
  const cold = isColdCompactEnabled()
  try {
    const result = await compactConversation(
      messages,
      params.toolUseContext,
      params,
      true,
      undefined,
      true,
      {
        isRecompactionInChain: false,
        turnsSincePreviousCompact: 0,
        autoCompactThreshold: 0,
      },
      cold ? { stripNonEssential: true } : undefined,
    )
    return result
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
