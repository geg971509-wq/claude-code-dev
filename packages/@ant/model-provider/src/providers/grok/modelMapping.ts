import { strip1mContextSuffix } from '../../shared/modelId.js'

export type GrokApiBackend = 'chat_completions' | 'responses' | 'messages'
export type GrokReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export type GrokModelMetadata = {
  contextWindow: number
  apiBackend: GrokApiBackend
  supportsBackendSearch: boolean
  supportsReasoningEffort: boolean
  defaultReasoningEffort?: GrokReasoningEffort
  reasoningEfforts: readonly GrokReasoningEffort[]
}

/** Current default from grok-build's xai-grok-models/default_models.json. */
export const GROK_DEFAULT_MODEL = 'grok-4.6'

/**
 * Keep this table intentionally small and sourced from grok-build's official
 * default model catalog. Unknown/custom Grok model IDs remain pass-through and
 * keep the legacy Chat Completions transport unless the user explicitly sets
 * GROK_API_BACKEND.
 */
const OFFICIAL_MODEL_METADATA: Readonly<Record<string, GrokModelMetadata>> = {
  'grok-4.6': {
    contextWindow: 500_000,
    apiBackend: 'responses',
    supportsBackendSearch: true,
    supportsReasoningEffort: true,
    defaultReasoningEffort: 'high',
    reasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
  },
  'grok-4.5': {
    contextWindow: 500_000,
    apiBackend: 'responses',
    supportsBackendSearch: false,
    supportsReasoningEffort: true,
    defaultReasoningEffort: 'high',
    reasoningEfforts: ['high', 'medium', 'low'],
  },
}

/**
 * Claude Code exposes Anthropic-shaped model tiers to the UI. grok-build does
 * not split its current defaults by Claude family: its default, web-search,
 * image-description, and session-summary model are all grok-4.6. Mirror that
 * behavior rather than preserving stale grok-3/grok-4.20 aliases.
 */
const DEFAULT_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': GROK_DEFAULT_MODEL,
  'claude-sonnet-4-5-20250929': GROK_DEFAULT_MODEL,
  'claude-sonnet-4-6': GROK_DEFAULT_MODEL,
  'claude-opus-4-20250514': GROK_DEFAULT_MODEL,
  'claude-opus-4-1-20250805': GROK_DEFAULT_MODEL,
  'claude-opus-4-5-20251101': GROK_DEFAULT_MODEL,
  'claude-opus-4-6': GROK_DEFAULT_MODEL,
  'claude-haiku-4-5-20251001': GROK_DEFAULT_MODEL,
  'claude-3-5-haiku-20241022': GROK_DEFAULT_MODEL,
  'claude-3-7-sonnet-20250219': GROK_DEFAULT_MODEL,
  'claude-3-5-sonnet-20241022': GROK_DEFAULT_MODEL,
}

const DEFAULT_FAMILY_MAP: Record<string, string> = {
  opus: GROK_DEFAULT_MODEL,
  sonnet: GROK_DEFAULT_MODEL,
  haiku: GROK_DEFAULT_MODEL,
}

function getModelFamily(model: string): 'haiku' | 'sonnet' | 'opus' | null {
  if (/haiku/i.test(model)) return 'haiku'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return null
}

function getUserModelMap(): Record<string, string> | null {
  const raw = process.env.GROK_MODEL_MAP
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    )
    return Object.fromEntries(entries)
  } catch {
    // Invalid user override: fall back to the official catalog.
    return null
  }
}

function normalizeBackend(value: string | undefined): GrokApiBackend | null {
  switch (value?.trim().toLowerCase()) {
    case 'responses':
      return 'responses'
    case 'messages':
      return 'messages'
    case 'chat':
    case 'chat_completions':
    case 'chat-completions':
      return 'chat_completions'
    default:
      return null
  }
}

export function getGrokModelMetadata(model: string): GrokModelMetadata | null {
  const cleanModel = strip1mContextSuffix(model).toLowerCase()
  return OFFICIAL_MODEL_METADATA[cleanModel] ?? null
}

/**
 * The official current catalog pins grok-4.5/4.6 to Responses. Preserve the
 * older OpenAI-compatible Chat Completions behavior for custom/legacy model
 * IDs so existing third-party endpoints do not break during this alignment.
 */
export function resolveGrokApiBackend(model: string): GrokApiBackend {
  const explicit = normalizeBackend(process.env.GROK_API_BACKEND)
  if (explicit) return explicit
  return getGrokModelMetadata(model)?.apiBackend ?? 'chat_completions'
}

/**
 * Clamp Claude's generic effort vocabulary to the effort levels exposed by
 * the selected official Grok model. `max` maps to xhigh on grok-4.6 and to the
 * model default on models that do not expose xhigh.
 */
export function normalizeGrokReasoningEffort(
  model: string,
  effort: unknown,
): GrokReasoningEffort | undefined {
  const metadata = getGrokModelMetadata(model)
  if (metadata && !metadata.supportsReasoningEffort) return undefined

  if (effort === undefined || effort === null || effort === '') {
    return metadata?.defaultReasoningEffort
  }
  if (typeof effort !== 'string') {
    return metadata?.defaultReasoningEffort
  }

  const normalized = effort.toLowerCase()
  const candidate =
    normalized === 'max'
      ? metadata?.reasoningEfforts.includes('xhigh')
        ? 'xhigh'
        : metadata?.defaultReasoningEffort
      : normalized

  if (
    candidate === 'low' ||
    candidate === 'medium' ||
    candidate === 'high' ||
    candidate === 'xhigh'
  ) {
    if (!metadata || metadata.reasoningEfforts.includes(candidate)) {
      return candidate
    }
  }
  return metadata?.defaultReasoningEffort
}

/** Resolve the Grok model name for a given Anthropic-facing model name. */
export function resolveGrokModel(anthropicModel: string): string {
  if (process.env.GROK_MODEL) {
    return strip1mContextSuffix(process.env.GROK_MODEL)
  }

  const cleanModel = strip1mContextSuffix(anthropicModel)
  const family = getModelFamily(cleanModel)

  const userMap = getUserModelMap()
  if (userMap && family && userMap[family]) {
    return strip1mContextSuffix(userMap[family])
  }

  if (family) {
    const grokEnvVar = `GROK_DEFAULT_${family.toUpperCase()}_MODEL`
    const grokOverride = process.env[grokEnvVar]
    if (grokOverride) return strip1mContextSuffix(grokOverride)

    // Retain the existing compatibility escape hatch for installations that
    // historically pinned their third-party model through Anthropic env vars.
    const anthropicEnvVar = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
    const anthropicOverride = process.env[anthropicEnvVar]
    if (anthropicOverride) return strip1mContextSuffix(anthropicOverride)
  }

  if (DEFAULT_MODEL_MAP[cleanModel]) {
    return DEFAULT_MODEL_MAP[cleanModel]
  }

  if (family && DEFAULT_FAMILY_MAP[family]) {
    return DEFAULT_FAMILY_MAP[family]
  }

  return cleanModel
}
