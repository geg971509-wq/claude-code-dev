import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppStateStore.js'
import listAgentsCommand, { runListAgentsCommand } from '../index.js'

describe('list-agents command', () => {
  test('exposes the peer roster without colliding with /agents', () => {
    expect(listAgentsCommand.name).toBe('list-agents')
    expect(listAgentsCommand.aliases).toEqual(['peers'])
    expect(listAgentsCommand.supportsNonInteractive).toBe(true)
  })

  test('renders the shared ListAgents result', async () => {
    const result = await runListAgentsCommand(
      {
        agentNameRegistry: new Map(),
        tasks: {},
      } as AppState,
      {
        listLocal: async () => [
          {
            kind: 'local-session',
            transport: 'uds',
            id: 'session-1',
            name: 'worker',
            address: 'uds:/tmp/worker.sock',
          },
        ],
        listCloud: async () => [],
        listBridge: async () => [],
        getSelfIds: () => [],
      },
    )

    expect(result.type).toBe('text')
    if (result.type === 'text') expect(result.value).toContain('worker [')
  })
})
