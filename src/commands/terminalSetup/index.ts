import type { Command } from '../../commands.js'
import { env } from '../../utils/env.js'
import { nativeCsiuDisplayName } from './nativeCsiu.js'

const terminalSetup = {
  type: 'local-jsx',
  name: 'terminal-setup',
  get description() {
    if (env.terminal === 'Apple_Terminal') {
      return 'Enable Option+Enter key binding for newlines and visual bell'
    }
    const native = nativeCsiuDisplayName(env.terminal)
    if (native === 'iTerm2') {
      return 'Check terminal setup (Shift+Enter is native; enables clipboard access in iTerm2)'
    }
    if (native) {
      return `Check terminal setup (Shift+Enter is natively supported in ${native})`
    }
    return 'Install Shift+Enter key binding for newlines'
  },
  load: () => import('./terminalSetup.js'),
} satisfies Command

export default terminalSetup
