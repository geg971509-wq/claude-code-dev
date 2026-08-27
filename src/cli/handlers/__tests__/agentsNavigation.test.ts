import { expect, test } from 'bun:test'
import { runAgentFleetNavigation } from '../agents.js'

test('definitions returns to the running Fleet instead of exiting', async () => {
  const screens = ['definitions', 'exit'] as const
  let rendered = 0
  let definitions = 0

  await runAgentFleetNavigation(
    async () => screens[rendered++] ?? 'exit',
    async () => {
      definitions++
    },
  )

  expect(rendered).toBe(2)
  expect(definitions).toBe(1)
})
