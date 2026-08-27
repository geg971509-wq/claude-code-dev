import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { KeybindingSetup, wrappedRender } from '@anthropic/ink'
import React from 'react'
import stripAnsi from 'strip-ansi'
import type {
  AgentFleetAction,
  AgentFleetActionResult,
  AgentFleetRecord,
  AgentFleetSnapshot,
} from '../../../services/agentFleet/types.js'
import { AppStoreContext, getDefaultAppState } from '../../../state/AppState.js'
import { createStore } from '../../../state/store.js'
import {
  AgentFleetView,
  availableFleetActions,
  filterFleetRecords,
  fleetViewStatus,
} from '../AgentFleetView.js'

function record(
  id: string,
  capabilities: AgentFleetRecord['capabilities'],
): AgentFleetRecord {
  return {
    id,
    startedAt: 1,
    updatedAt: 1,
    revision: `${id}:1`,
    name: id,
    state: id === 'blocked-peer' ? 'blocked' : 'working',
    source: id === 'blocked-peer' ? 'peer' : 'background',
    cwd: id === 'blocked-peer' ? '/remote/project' : '/local/project',
    capabilities,
  }
}

function snapshot(
  records: AgentFleetRecord[],
  partial = false,
): AgentFleetSnapshot {
  return {
    generatedAt: 10,
    revision: 'snapshot:1',
    cwd: '/local/project',
    records,
    partial,
    unavailableSources: partial ? ['peer'] : [],
  }
}

describe('AgentFleetView model', () => {
  test('distinguishes loading, empty, partial, error, and stale states', () => {
    expect(fleetViewStatus(undefined, true, undefined)).toBe('loading')
    expect(fleetViewStatus(snapshot([]), false, undefined)).toBe('empty')
    expect(
      fleetViewStatus(snapshot([record('worker', [])], true), false, undefined),
    ).toBe('partial')
    expect(fleetViewStatus(undefined, false, 'offline')).toBe('error')
    expect(
      fleetViewStatus(snapshot([record('worker', [])]), false, 'offline'),
    ).toBe('stale')
  })

  test('filters the unified roster across identity, state, source, and cwd', () => {
    const records = [record('worker', []), record('blocked-peer', [])]

    expect(filterFleetRecords(records, 'blocked')).toEqual([records[1]])
    expect(filterFleetRecords(records, 'peer')).toEqual([records[1]])
    expect(filterFleetRecords(records, '/local')).toEqual([records[0]])
    expect(filterFleetRecords([...records, records[0]!], '')).toEqual(records)
  })

  test('exposes only shortcuts backed by record capabilities', () => {
    expect(
      availableFleetActions(
        record('worker', ['message', 'logs', 'resume', 'retry']),
      ).map(action => action.type),
    ).toEqual(['message', 'logs', 'resume', 'retry'])
  })
})

test('Ink Fleet supports detail, filtering, and capability-gated actions', async () => {
  const peer = record('blocked-peer', ['message'])
  const actions: AgentFleetAction[] = []
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  Object.assign(stdin, {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  const stdout = new PassThrough()
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const view = React.createElement(AgentFleetView, {
    onDefinitions() {},
    onExit() {},
    refreshIntervalMs: 0,
    loadSnapshot: async () => snapshot([record('worker', []), peer]),
    dispatchAction: async (
      _record: AgentFleetRecord,
      action: AgentFleetAction,
    ): Promise<AgentFleetActionResult> => {
      actions.push(action)
      return { ok: true, action: action.type, id: action.id }
    },
  })
  const keybindingProps = {
    loadBindings: () => ({ bindings: [], warnings: [] }),
    subscribeToChanges: () => () => {},
    children: view,
  }
  const root = await wrappedRender(
    React.createElement(
      AppStoreContext.Provider,
      { value: createStore(getDefaultAppState()) },
      React.createElement(KeybindingSetup, keybindingProps),
    ),
    {
      stdin,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    },
  )

  try {
    await Bun.sleep(30)
    expect(output).toContain('Tips:')
    output = ''
    stdin.write('\u001b[B')
    stdin.write('\r')
    await Bun.sleep(20)
    expect(output).toContain('State: blocked')
    expect(output).not.toContain('Tips:')

    output = ''
    stdin.write('\r')
    await Bun.sleep(10)
    stdin.write('/')
    await Bun.sleep(10)
    stdin.write('peer')
    await Bun.sleep(10)
    stdin.write('\r')
    await Bun.sleep(20)
    expect(output).toContain('Filter: peer')
    expect(output).toContain('m message')
    expect(output).not.toContain('s stop')
    expect(output).not.toContain('l logs')

    stdin.write('m')
    await Bun.sleep(10)
    stdin.write('hello')
    await Bun.sleep(10)
    stdin.write('\r')
    await Bun.sleep(20)
    expect(actions).toEqual([
      expect.objectContaining({
        type: 'message',
        id: peer.id,
        content: 'hello',
      }),
    ])
  } finally {
    root.unmount()
  }
})

test('Ink Fleet keeps state and source readable in a narrow terminal', async () => {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  Object.assign(stdin, {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
  Object.assign(stdout, { columns: 54, rows: 24 })
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const view = React.createElement(AgentFleetView, {
    onDefinitions() {},
    onExit() {},
    refreshIntervalMs: 0,
    loadSnapshot: async () =>
      snapshot([
        {
          ...record('376f3b26-975c-4d96-829a-f77ea5315499', []),
          source: 'peer' as const,
          cwd: '/Volumes/work/software/install/cc-switch',
        },
        {
          ...record('verify-solusdt-best-results', []),
          source: 'peer' as const,
          cwd: '/Users/king/Desktop/SOLUSDT',
        },
      ]),
  })
  const keybindingProps = {
    loadBindings: () => ({ bindings: [], warnings: [] }),
    subscribeToChanges: () => () => {},
    children: view,
  }
  const root = await wrappedRender(
    React.createElement(
      AppStoreContext.Provider,
      { value: createStore(getDefaultAppState()) },
      React.createElement(KeybindingSetup, keybindingProps),
    ),
    { stdin, stdout, patchConsole: false },
  )

  try {
    await Bun.sleep(30)
    const frame = stripAnsi(output)
    expect(frame).toContain('… · working · peer')
    expect(frame).not.toContain('f77ea5315499')
    expect(frame).not.toContain('cc-switch')
    expect(frame).not.toContain(' · /…T')
  } finally {
    root.unmount()
  }
})
