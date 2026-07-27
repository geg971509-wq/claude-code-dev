/**
 * Pure utility functions for building OpenAI request bodies and detecting
 * thinking mode. Extracted from index.ts so tests can import them without
 * triggering heavy module side-effects (OpenAI client, stream adapter, etc.).
 */
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions/completions.mjs'
import { isEnvTruthy, isEnvDefinedFalsy } from '../../../utils/envUtils.js'

/**
 * Detect whether thinking mode should be enabled for this model.
 *
 * Enabled when:
 * 1. OPENAI_ENABLE_THINKING=1 is set (explicit enable), OR
 * 2. Model name contains "deepseek" or "mimo" (auto-detect, case-insensitive)
 *
 * Disabled when:
 * - OPENAI_ENABLE_THINKING=0/false/no/off is explicitly set (overrides model detection)
 *
 * @param model - The resolved OpenAI model name
 */
export function isOpenAIThinkingEnabled(model: string): boolean {
  // Explicit disable takes priority (overrides model auto-detect)
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return false
  // Explicit enable
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return true
  // Auto-detect from model name (DeepSeek and MiMo models support thinking mode).
  // Grok is intentionally excluded — Grok reasoning models reason automatically
  // and do NOT require thinking/enable_thinking request body parameters.
  const modelLower = model.toLowerCase()
  return modelLower.includes('deepseek') || modelLower.includes('mimo')
}

function parsePositiveInteger(
  value: number | string | undefined,
): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Resolve max output tokens for the OpenAI-compatible path.
 *
 * Override priority:
 * 1. maxOutputTokensOverride (programmatic, from query pipeline)
 * 2. OPENAI_MAX_TOKENS env var (OpenAI-specific, useful for local models
 *    with small context windows, e.g. RTX 3060 12GB running 65536-token models)
 * 3. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var (generic override)
 * 4. upperLimit default (64000)
 */
export function resolveOpenAIMaxTokens(
  upperLimit: number,
  maxOutputTokensOverride?: number,
): number {
  return (
    parsePositiveInteger(maxOutputTokensOverride) ??
    parsePositiveInteger(process.env.OPENAI_MAX_TOKENS) ??
    parsePositiveInteger(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) ??
    upperLimit
  )
}

/**
 * OpenAI Chat Completions reasoning models that reject `max_tokens` and
 * require `max_completion_tokens` (o-series + GPT-5 reasoning, not gpt-5-chat).
 */
export function isOpenAIReasoningChatModel(model: string): boolean {
  const m = model.toLowerCase()
  if (/^o\d/.test(m)) return true
  return m.includes('gpt-5') && !m.includes('gpt-5-chat')
}

export function supportsOpenAIReasoningEffortNone(model: string): boolean {
  const match = model.toLowerCase().match(/^gpt-5\.(\d+)(?:-|$)/)
  return match ? Number(match[1]) >= 1 : false
}

/**
 * Moonshot Kimi models on the OpenAI-compatible endpoint.
 *
 * Matched on the resolved model id only — this path never sees a base URL or
 * provider id, so the id is the one honest signal available.
 *
 * Anchored to the start of the id or a `vendor/` prefix (`kimi-k3`,
 * `moonshotai/kimi-k2`) rather than matching `kimi` anywhere, because the two
 * quirks gated on this are subtractive: a false positive silently strips
 * `temperature` from a model that wanted it, with nothing in the response to
 * indicate why. Router and gateway deployments rename models freely, and
 * `my-kimi-route` or `kimi-proxy-fallback` naming a non-Moonshot upstream is
 * ordinary. A hyphen is required after `kimi` so the match is a family prefix
 * and not a word that merely starts with it.
 *
 * The reverse miss — a Moonshot model not named `kimi-*` — degrades to sending
 * `temperature`, which surfaces as a loud 400 rather than a silent wrong answer.
 * That asymmetry is why this errs toward matching less.
 */
const KIMI_FAMILY_RE = /(?:^|\/)kimi-/i

export function isKimiModel(model: string): boolean {
  return KIMI_FAMILY_RE.test(model)
}

/** Effort levels Moonshot accepts. Anything else is a hard 400. */
export type KimiReasoningEffort = 'low' | 'high' | 'max'

/**
 * Clamp Claude Code's six effort levels onto the three Moonshot accepts,
 * mirroring the aliasing the Kimi gateway documents.
 *
 * `max` is included for completeness — streamAttempt.ts converts `max` to
 * `xhigh` before this module sees it, so `xhigh` is what restores that intent.
 */
export function toKimiReasoningEffort(
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
): KimiReasoningEffort {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
      return 'max'
  }
}

/**
 * Codex-aligned Azure Responses host markers (hostname only).
 * Shared by routing capability and `store` default so the two cannot drift.
 */
function isAzureResponsesHostname(host: string): boolean {
  return (
    host.includes('openai.azure.') ||
    host.includes('cognitiveservices.azure.') ||
    host.includes('aoai.azure.') ||
    host.endsWith('.azure-api.net') ||
    host.endsWith('.azurefd.net')
  )
}

/**
 * Whether OPENAI_BASE_URL is an Azure Responses endpoint (`store: true` policy).
 * Uses hostname markers; also accepts classic `*.windows.net` bases whose path
 * contains `/openai` (Codex substring set).
 */
export function isAzureResponsesBaseURL(
  baseURL: string | undefined = process.env.OPENAI_BASE_URL,
): boolean {
  if (!baseURL?.trim()) return false
  try {
    const u = new URL(baseURL)
    const host = u.hostname.toLowerCase()
    if (isAzureResponsesHostname(host)) return true
    return (
      host.endsWith('.windows.net') &&
      u.pathname.toLowerCase().includes('/openai')
    )
  } catch {
    // Malformed URL: keep previous substring fall-back for store policy only.
    const u = baseURL.toLowerCase()
    return (
      u.includes('openai.azure.') ||
      u.includes('cognitiveservices.azure.') ||
      u.includes('aoai.azure.') ||
      u.includes('azure-api.') ||
      u.includes('azurefd.') ||
      u.includes('windows.net/openai')
    )
  }
}

/**
 * Hosts known to speak OpenAI/Azure Responses (`/responses`).
 * Used by automatic routing, Azure `store` policy, and diagnostics.
 */
export function isOpenAIResponsesCapableBaseURL(
  baseURL: string | undefined = process.env.OPENAI_BASE_URL,
): boolean {
  if (!baseURL?.trim()) return true // SDK default: api.openai.com
  try {
    const u = new URL(baseURL)
    const host = u.hostname.toLowerCase()
    if (host === 'api.openai.com') return true
    if (isAzureResponsesHostname(host)) return true
    return (
      host.endsWith('.windows.net') &&
      u.pathname.toLowerCase().includes('/openai')
    )
  } catch {
    return false
  }
}

/**
 * Whether the API-key path should use `/v1/responses`.
 *
 * - OPENAI_USE_RESPONSES=0/false → never
 * - OPENAI_USE_RESPONSES=1/true → always
 * - else auto: o-series / gpt-5* on known OpenAI/Azure Responses endpoints
 */
export function shouldUseOpenAIResponsesAPI(model: string): boolean {
  if (isEnvDefinedFalsy(process.env.OPENAI_USE_RESPONSES)) return false
  if (isEnvTruthy(process.env.OPENAI_USE_RESPONSES)) return true
  return isOpenAIReasoningChatModel(model) && isOpenAIResponsesCapableBaseURL()
}

/** Optional prompt cache key for Responses (omit when unset). */
export function resolveOpenAIPromptCacheKey(): string | undefined {
  const key = process.env.OPENAI_PROMPT_CACHE_KEY?.trim()
  return key ? key : undefined
}

/**
 * Build the request body for OpenAI chat.completions.create().
 * Extracted for testability — the thinking mode params are injected here.
 *
 * Three thinking-mode formats are sent simultaneously; each endpoint uses the
 * format it recognizes and ignores the others:
 * - Official DeepSeek API:    `thinking: { type: 'enabled' }`
 * - Self-hosted DeepSeek:     `enable_thinking: true` + `chat_template_kwargs: { thinking: true }`
 * - MiMo (Xiaomi):            `chat_template_kwargs: { enable_thinking: true }`
 * OpenAI SDK passes unknown keys through to the HTTP body.
 */
export type OpenAIJSONOutputFormat = {
  type: 'json_schema'
  schema: Record<string, unknown>
}

export function buildOpenAIRequestBody(params: {
  model: string
  messages: any[]
  tools: any[]
  toolChoice: any
  enableThinking: boolean
  maxTokens: number
  temperatureOverride?: number
  /** Session-scoped routing key for official OpenAI requests. */
  promptCacheKey?: string
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  outputFormat?: OpenAIJSONOutputFormat
  stopSequences?: string[]
  // `reasoning_effort` is omitted from the SDK type and redeclared below:
  // intersecting with the SDK's narrower union would just re-narrow it, and
  // Moonshot's `max` is not one of OpenAI's levels.
}): Omit<ChatCompletionCreateParamsStreaming, 'reasoning_effort'> & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
  /** OpenAI prompt-cache routing key (not always in SDK types yet). */
  prompt_cache_key?: string
  max_completion_tokens?: number
  reasoning_effort?:
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'
} {
  const {
    model,
    messages,
    tools,
    toolChoice,
    enableThinking,
    maxTokens,
    temperatureOverride,
    promptCacheKey,
    reasoningEffort,
    outputFormat,
    stopSequences,
  } = params
  const isReasoningChat = isOpenAIReasoningChatModel(model)
  const isKimi = isKimiModel(model)
  return {
    model,
    messages,
    ...(isReasoningChat
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
    // Kimi takes a top-level reasoning_effort but is not an OpenAI reasoning
    // chat model, so it needs its own gate — and its own clamp, because
    // Moonshot 400s on any level outside low/high/max. Without this it silently
    // runs at the server default (max), the expensive end of the model.
    ...(isKimi && reasoningEffort
      ? { reasoning_effort: toKimiReasoningEffort(reasoningEffort) }
      : isReasoningChat &&
        reasoningEffort && {
          reasoning_effort: reasoningEffort,
        }),
    ...(promptCacheKey && { prompt_cache_key: promptCacheKey }),
    ...(outputFormat && {
      response_format: {
        type: 'json_schema' as const,
        json_schema: {
          name: 'side_query_output',
          schema: outputFormat.schema,
          strict: true,
        },
      },
    }),
    ...(!isReasoningChat &&
      stopSequences &&
      stopSequences.length > 0 && { stop: stopSequences }),
    ...(tools.length > 0 && {
      tools,
      ...(toolChoice && { tool_choice: toolChoice }),
    }),
    stream: true,
    stream_options: { include_usage: true },
    // Enable chain-of-thought output for DeepSeek and MiMo models.
    // When active, temperature/top_p/presence_penalty/frequency_penalty are ignored.
    ...(enableThinking && {
      // Official DeepSeek API format
      thinking: { type: 'enabled' },
      // Self-hosted DeepSeek-V3.2 format
      enable_thinking: true,
      // Both DeepSeek self-hosted and MiMo formats in chat_template_kwargs
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }),
    // Only send temperature when thinking mode is off (DeepSeek ignores it anyway,
    // but other providers may respect it).
    // Kimi is excluded outright: Moonshot fixes temperature server-side and
    // errors on any explicit value, and the hook side-queries pass 0 — so
    // sending it would fail memory extraction while the main loop looked fine.
    ...(!enableThinking &&
      !isKimi &&
      temperatureOverride !== undefined && {
        temperature: temperatureOverride,
      }),
  }
}
