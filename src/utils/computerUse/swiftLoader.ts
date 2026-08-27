import type { ComputerUseAPI } from '@ant/computer-use-swift'

let cached: ComputerUseAPI | undefined

/**
 * macOS-only loader for @ant/computer-use-swift.
 * Non-darwin platforms should use src/utils/computerUse/platforms/ instead.
 */
export function requireComputerUseSwift(): ComputerUseAPI {
  if (cached) return cached
  const mod = require('@ant/computer-use-swift')
  if (mod.computerUse) {
    cached = mod.computerUse as ComputerUseAPI
  } else {
    cached = mod as ComputerUseAPI
  }
  return cached
}

export function requestComputerUseTccPermission(
  permission: 'accessibility' | 'screenRecording',
): void {
  const { tcc } = requireComputerUseSwift()
  if (permission === 'accessibility') {
    tcc?.requestAccessibility()
  } else {
    tcc?.requestScreenRecording()
  }
}

export type { ComputerUseAPI }
