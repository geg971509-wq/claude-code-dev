export type CodexWireReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'disabled'
  | (string & {})

export type CodexReasoningProvider = 'openai' | 'codex'

type ReasoningEnv = Readonly<Record<string, string | undefined>>

type ResolveCodexReasoningEffortOptions = {
  model: string
  configured?: unknown
  provider: CodexReasoningProvider
  env?: ReasoningEnv
  supportedEfforts?: readonly string[]
  multiAgentOverride?: string
}

const EFFORT_ASCENDING = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  return normalized.length > 0 ? normalized : undefined
}

function parseSupportedEfforts(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }
  const parsed = value
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)
  return parsed.length > 0 ? [...new Set(parsed)] : undefined
}

function inferSupportedEfforts(model: string): string[] {
  const normalized = model.trim().toLowerCase()

  // Codex obtains this information from its model catalog. The development
  // client has no dynamic catalog for third-party OpenAI endpoints, so keep
  // the inference conservative and allow an explicit catalog projection via
  // *_SUPPORTED_REASONING_EFFORTS.
  const version = normalized.match(/^gpt-5\.(\d+)(?:-|$)/)
  if (version) {
    const minor = Number(version[1])
    if (minor >= 2) {
      return [...EFFORT_ASCENDING]
    }
    if (minor >= 1) {
      return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
    }
  }

  if (/^gpt-5(?:-|$)/.test(normalized)) {
    return ['minimal', 'low', 'medium', 'high']
  }

  if (/^o\d(?:-|$)/.test(normalized)) {
    return ['low', 'medium', 'high']
  }

  return []
}

function selectUltraFallback(
  supportedEfforts: readonly string[],
  multiAgentOverride: string | undefined,
): string {
  const normalized = new Set(
    supportedEfforts.map(value => value.trim().toLowerCase()).filter(Boolean),
  )

  if (multiAgentOverride && normalized.has(multiAgentOverride)) {
    return multiAgentOverride
  }
  if (normalized.has('max')) {
    return 'max'
  }

  for (let index = EFFORT_ASCENDING.length - 1; index >= 0; index -= 1) {
    const effort = EFFORT_ASCENDING[index]
    if (effort !== 'max' && normalized.has(effort)) {
      return effort
    }
  }

  return 'medium'
}

function providerEnvPrefix(provider: CodexReasoningProvider): 'OPENAI' | 'CODEX' {
  return provider === 'codex' ? 'CODEX' : 'OPENAI'
}

function resolveRawEffort(
  configured: unknown,
  provider: CodexReasoningProvider,
  env: ReasoningEnv,
): unknown {
  const prefix = providerEnvPrefix(provider)
  const providerOverride = normalizedString(
    env[`${prefix}_REASONING_EFFORT`],
  )
  const globalOverride = normalizedString(env.CLAUDE_CODE_EFFORT_LEVEL)
  const override = providerOverride ?? globalOverride

  if (override === 'unset') {
    return undefined
  }
  if (
    override === undefined ||
    override === 'auto' ||
    override === 'default'
  ) {
    return configured
  }

  return override
}

/**
 * Resolve the Responses API reasoning effort using Codex semantics.
 *
 * - `persistent` is a local behavior name; its wire representation is
 *   `disabled`, matching Codex.
 * - `ultra` is model-aware: prefer a catalog override, then max, then the
 *   highest supported non-ultra level, finally medium.
 * - Provider-specific env overrides remain isolated to GPT/OpenAI paths.
 */
export function resolveCodexResponsesReasoningEffort({
  model,
  configured,
  provider,
  env = process.env,
  supportedEfforts,
  multiAgentOverride,
}: ResolveCodexReasoningEffortOptions): CodexWireReasoningEffort | undefined {
  const raw = resolveRawEffort(configured, provider, env)

  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? 'high' : undefined
  }

  const normalized = normalizedString(raw)
  if (!normalized) {
    return undefined
  }

  if (normalized === 'persistent') {
    return 'disabled'
  }

  if (normalized === 'ultra') {
    const prefix = providerEnvPrefix(provider)
    const envSupported = parseSupportedEfforts(
      env[`${prefix}_SUPPORTED_REASONING_EFFORTS`],
    )
    const supported =
      supportedEfforts ?? envSupported ?? inferSupportedEfforts(model)
    const override = normalizedString(
      multiAgentOverride ?? env[`${prefix}_MULTI_AGENT_REASONING_EFFORT`],
    )
    return selectUltraFallback(supported, override)
  }

  // Codex permits catalog-specific custom effort values. Preserve them at
  // this protocol boundary instead of narrowing requests to a stale SDK union.
  return normalized as CodexWireReasoningEffort
}

export function applyCodexReasoningToRequest(
  request: Record<string, unknown>,
  options: Omit<ResolveCodexReasoningEffortOptions, 'configured'>,
): void {
  const existing =
    request.reasoning && typeof request.reasoning === 'object'
      ? { ...(request.reasoning as Record<string, unknown>) }
      : {}
  const effort = resolveCodexResponsesReasoningEffort({
    ...options,
    configured: existing.effort,
  })

  if (!effort) {
    delete request.reasoning
    return
  }

  request.reasoning = {
    ...existing,
    effort,
    ...(existing.summary === undefined &&
    effort !== 'max' &&
    effort !== 'none' &&
    effort !== 'disabled'
      ? { summary: 'auto' }
      : {}),
  }
}
