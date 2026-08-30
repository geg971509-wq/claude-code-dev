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

type ResolveCodexReasoningEffortOptions = {
  model: string
  configured?: unknown
  provider: CodexReasoningProvider
  env?: NodeJS.ProcessEnv
  supportedEfforts?: readonly string[]
  multiAgentOverride?: string
}

const STANDARD_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'disabled',
])

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
  // the inference intentionally conservative and allow an explicit catalog
  // projection through *_SUPPORTED_REASONING_EFFORTS.
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
  env: NodeJS.ProcessEnv,
): unknown {
  const prefix = providerEnvPrefix(provider)
  const providerOverride = env[`${prefix}_REASONING_EFFORT`]
  const globalOverride = env.CLAUDE_CODE_EFFORT_LEVEL
  const rawOverride = providerOverride ?? globalOverride
  const normalizedOverride = normalizedString(rawOverride)

  if (
    normalizedOverride === undefined ||
    normalizedOverride === 'auto' ||
    normalizedOverride === 'unset' ||
    normalizedOverride === 'default'
  ) {
    return configured
  }

  return normalizedOverride
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
      multiAgentOverride ??
        env[`${prefix}_MULTI_AGENT_REASONING_EFFORT`],
    )
    return selectUltraFallback(supported, override)
  }

  // Codex allows model-catalog-specific custom effort strings. Preserve them
  // instead of narrowing every request to today's static SDK union.
  return STANDARD_EFFORTS.has(normalized)
    ? (normalized as CodexWireReasoningEffort)
    : (normalized as CodexWireReasoningEffort)
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
    return
  }

  request.reasoning = {
    ...existing,
    effort,
    ...(existing.summary === undefined && effort !== 'max'
      ? { summary: 'auto' }
      : {}),
  }
}
