import { describe, expect, mock, test } from 'bun:test'
import { createAgentFleetOwnerHandlers } from '../owner.js'
import type {
  AgentFleetAction,
  AgentFleetActionResult,
  AgentFleetSnapshot,
} from '../types.js'

function snapshot(revision: string): AgentFleetSnapshot {
  return {
    generatedAt: 1,
    revision,
    cwd: '/workspace',
    partial: false,
    unavailableSources: [],
    records: [
      {
        id: 'task:owner:child',
        startedAt: 1,
        updatedAt: 2,
        revision,
        state: 'working',
        source: 'background',
        capabilities: ['stop'],
      },
    ],
  }
}

describe('Agent Fleet owner handlers', () => {
  test('reloads the owner snapshot immediately before dispatch', async () => {
    let current = snapshot('r1')
    const dispatch = mock(
      async (
        record: AgentFleetSnapshot['records'][number] | undefined,
        action: AgentFleetAction,
      ): Promise<AgentFleetActionResult> =>
        record?.revision === action.revision
          ? { ok: true, action: action.type, id: action.id }
          : { ok: false, code: 'stale', message: 'owner state changed' },
    )
    const handlers = createAgentFleetOwnerHandlers({
      buildSnapshot: async () => current,
      dispatch,
    })
    current = snapshot('r2')

    const result = await handlers.action({
      type: 'stop',
      id: 'task:owner:child',
      revision: 'r1',
      updatedAt: 2,
    })

    expect(result).toEqual({
      ok: false,
      code: 'stale',
      message: 'owner state changed',
    })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 'r2' }),
      expect.objectContaining({ revision: 'r1' }),
    )
  })
})
