export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'gemini'
  | 'grok'
  | 'codex'

export function isThirdPartyAPIProvider(provider: APIProvider): boolean {
  return provider !== 'firstParty'
}
