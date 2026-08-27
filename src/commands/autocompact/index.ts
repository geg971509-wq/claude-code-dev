import type { Command } from '../../commands.js'

const autocompact = {
  type: 'local',
  name: 'autocompact',
  description: 'Show or set the automatic compaction context window',
  argumentHint: '[auto | TOKENS]',
  supportsNonInteractive: true,
  load: () => import('./autocompact.js'),
} satisfies Command

export default autocompact
