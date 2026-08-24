import { env } from '../../utils/env.js'

/** Terminals that natively support CSI u / Kitty keyboard protocol. */
export const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iTerm.app': 'iTerm2',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
  'windows-terminal': 'Windows Terminal',
}

export function nativeCsiuDisplayName(terminal: string | null): string | null {
  if (!terminal) return null
  return NATIVE_CSIU_TERMINALS[terminal] ?? null
}

export function getNativeCSIuTerminalDisplayName(): string | null {
  return nativeCsiuDisplayName(env.terminal)
}
