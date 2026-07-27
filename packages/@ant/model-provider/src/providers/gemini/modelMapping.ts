import { strip1mContextSuffix } from '../../shared/modelId.js'

function getModelFamily(model: string): 'haiku' | 'sonnet' | 'opus' | null {
  if (/haiku/i.test(model)) return 'haiku'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  return null
}

export function resolveGeminiModel(anthropicModel: string): string {
  if (process.env.GEMINI_MODEL) {
    // Stripped like every other branch: this one returned the raw env value, so
    // a preset that set `GEMINI_MODEL=...[1m]` to get a 1M auto-compact budget
    // sent the marker to the wire as part of the model id.
    return strip1mContextSuffix(process.env.GEMINI_MODEL)
  }

  const cleanModel = strip1mContextSuffix(anthropicModel)
  const family = getModelFamily(cleanModel)

  if (!family) {
    return cleanModel
  }

  const geminiEnvVar = `GEMINI_DEFAULT_${family.toUpperCase()}_MODEL`
  const geminiModel = process.env[geminiEnvVar]
  if (geminiModel) {
    return strip1mContextSuffix(geminiModel)
  }

  const sharedEnvVar = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`
  const resolvedModel = process.env[sharedEnvVar]
  if (resolvedModel) {
    return strip1mContextSuffix(resolvedModel)
  }

  throw new Error(
    `Gemini provider requires GEMINI_MODEL or ${geminiEnvVar} (or ${sharedEnvVar} for backward compatibility) to be configured.`,
  )
}
