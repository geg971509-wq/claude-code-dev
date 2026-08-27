import chalk from 'chalk'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  parseAutoCompactWindow,
  resolveAutoCompactWindow,
} from '../../services/compact/effectiveWindow.js'

export const call: LocalCommandCall = async (args, context) => {
  const value = args.trim()
  if (value) {
    const parsed = parseAutoCompactWindow(value)
    if (parsed === undefined) {
      throw new Error(
        'Use `auto` or a token window from 100k to 1M (for example 500k).',
      )
    }
    saveGlobalConfig(current => ({ ...current, autoCompactWindow: value }))
    const envOverride = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    const envIsActive =
      envOverride !== undefined &&
      parseAutoCompactWindow(envOverride) !== undefined
    return {
      type: 'text',
      value: envIsActive
        ? `Automatic compaction window set to ${value}.\n${chalk.dim('Environment override is active; the saved setting will apply after it is removed.')}`
        : `Automatic compaction window set to ${value}.`,
    }
  }
  const resolution = resolveAutoCompactWindow(context.options.mainLoopModel)
  const config = getGlobalConfig().autoCompactWindow
  const envOverride = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  const lines = [
    `Automatic compaction: ${resolution.configured}`,
    `Effective window: ${resolution.window.toLocaleString()} tokens`,
    `Source: ${resolution.source}${resolution.capped ? ' (capped by model)' : ''}`,
  ]
  if (envOverride && config && envOverride !== config) {
    lines.push(
      chalk.dim(
        'Environment override is active; the saved setting is not used.',
      ),
    )
  }
  return { type: 'text', value: lines.join('\n') }
}
