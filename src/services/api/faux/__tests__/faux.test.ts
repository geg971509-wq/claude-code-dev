import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('src/utils/debug.ts', debugMock)

const { fauxTurnIndex, parseFauxScript, queryModelFaux } = await import(
  '../index.js'
)
// isFauxProviderEnabled lives in the leaf env module, not next to the provider,
// so that auth/VCR/dispatch can read it without importing the Anthropic SDK.
const { isFauxProviderEnabled } = await import('../../../../utils/envUtils.js')

type AnyRecord = Record<string, any>
const tempDirs = new Set<string>()

function scriptFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'faux-'))
  tempDirs.add(dir)
  const path = join(dir, 'script.json')
  writeFileSync(
    path,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  )
  return path
}

async function drain(messages: AnyRecord[] = []): Promise<AnyRecord[]> {
  const out: AnyRecord[] = []
  for await (const item of queryModelFaux(
    messages as any,
    [] as any,
    [] as any,
    new AbortController().signal,
    { model: 'faux-1' } as any,
  )) {
    out.push(item as AnyRecord)
  }
  return out
}

const assistant = (text: string): AnyRecord => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_USE_FAUX
  delete process.env.CLAUDE_CODE_FAUX_SCRIPT
  delete process.env.CLAUDE_CODE_FAUX_DELAY_MS
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.clear()
})

describe('isFauxProviderEnabled', () => {
  test('only "1" enables it', () => {
    expect(isFauxProviderEnabled()).toBe(false)
    process.env.CLAUDE_CODE_USE_FAUX = 'true'
    expect(isFauxProviderEnabled()).toBe(false)
    process.env.CLAUDE_CODE_USE_FAUX = '1'
    expect(isFauxProviderEnabled()).toBe(true)
  })
})

describe('parseFauxScript', () => {
  test('accepts a bare array as shorthand for { turns }', () => {
    expect(parseFauxScript('[{"text":"hi"}]')).toEqual({
      turns: [{ text: 'hi' }],
    })
  })

  test('accepts the { turns } object form', () => {
    expect(parseFauxScript('{"turns":[{"text":"hi"}]}')).toEqual({
      turns: [{ text: 'hi' }],
    })
  })

  test('rejects a non-array turns field', () => {
    expect(() => parseFauxScript('{"turns":"nope"}')).toThrow(
      'expected an array of turns',
    )
  })

  test('rejects a non-string text field', () => {
    expect(() => parseFauxScript('[{"text":42}]')).toThrow(
      'turn 0: "text" must be a string',
    )
  })

  test('rejects a tool use without a name', () => {
    expect(() => parseFauxScript('[{"toolUses":[{"input":{}}]}]')).toThrow(
      'turn 0, toolUse 0: "name" must be a string',
    )
  })

  test('rejects a tool use whose input is not an object', () => {
    expect(() =>
      parseFauxScript('[{"toolUses":[{"name":"Read","input":"x"}]}]'),
    ).toThrow('turn 0, toolUse 0: "input" must be an object')
  })
})

describe('fauxTurnIndex', () => {
  test('counts assistant messages, ignoring API error messages', () => {
    expect(fauxTurnIndex([] as any)).toBe(0)
    expect(
      fauxTurnIndex([
        { type: 'user' },
        assistant('a'),
        { type: 'user' },
      ] as any),
    ).toBe(1)
    expect(
      fauxTurnIndex([
        assistant('a'),
        { type: 'assistant', isApiErrorMessage: true },
      ] as any),
    ).toBe(1)
  })
})

describe('queryModelFaux', () => {
  test('emits a well-formed event sequence for a text turn', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([
      { text: 'hello world, this is faux' },
    ])
    const out = await drain()
    const types = out.map(o =>
      o.type === 'stream_event' ? o.event.type : o.type,
    )
    expect(types[0]).toBe('message_start')
    expect(types.at(-1)).toBe('message_stop')
    expect(types).toContain('content_block_start')
    expect(types).toContain('message_delta')
    expect(types).toContain('assistant')

    // Text arrives as multiple deltas, and reassembles exactly.
    const deltas = out.filter(
      o => o.type === 'stream_event' && o.event.type === 'content_block_delta',
    )
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map(d => d.event.delta.text).join('')).toBe(
      'hello world, this is faux',
    )
  })

  test('yields an assistant message with deterministic ids and end_turn', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([{ text: 'done' }])
    const msg = (await drain()).find(o => o.type === 'assistant')!
    expect(msg.message.id).toBe('msg_faux_0')
    expect(msg.message.model).toBe('faux-1')
    expect(msg.message.stop_reason).toBe('end_turn')
    expect(msg.requestId).toBe('req_faux_0')
    expect(msg.message.usage.output_tokens).toBe(1)
  })

  test('tool uses get parsed input, a deterministic id, and stop_reason tool_use', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([
      {
        text: 'reading',
        toolUses: [{ name: 'Read', input: { file_path: '/tmp/a' } }],
      },
    ])
    const msg = (await drain()).find(o => o.type === 'assistant')!
    expect(msg.message.stop_reason).toBe('tool_use')
    const block = msg.message.content.find(
      (b: AnyRecord) => b.type === 'tool_use',
    )
    expect(block.id).toBe('toolu_faux_0_0')
    expect(block.name).toBe('Read')
    expect(block.input).toEqual({ file_path: '/tmp/a' })
  })

  test('an explicit tool use id wins over the generated one', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([
      { toolUses: [{ name: 'Read', input: {}, id: 'toolu_custom' }] },
    ])
    const msg = (await drain()).find(o => o.type === 'assistant')!
    expect(msg.message.content[0].id).toBe('toolu_custom')
  })

  test('thinking precedes text and is emitted as thinking deltas', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([
      { thinking: 'pondering hard', text: 'answer' },
    ])
    const out = await drain()
    const starts = out
      .filter(
        o =>
          o.type === 'stream_event' && o.event.type === 'content_block_start',
      )
      .map(o => o.event.content_block.type)
    expect(starts).toEqual(['thinking', 'text'])
    const thinkingDeltas = out.filter(
      o =>
        o.type === 'stream_event' && o.event.delta?.type === 'thinking_delta',
    )
    expect(thinkingDeltas.map(d => d.event.delta.thinking).join('')).toBe(
      'pondering hard',
    )
  })

  test('turn selection advances with assistant message count', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([
      { text: 'first' },
      { text: 'second' },
    ])
    const second = (await drain([{ type: 'user' }, assistant('first')])).find(
      o => o.type === 'assistant',
    )!
    expect(second.message.content[0].text).toBe('second')
    expect(second.message.id).toBe('msg_faux_1')
  })

  test('the same input replays the same content', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([{ text: 'stable' }])
    const a = (await drain()).find(o => o.type === 'assistant')!
    const b = (await drain()).find(o => o.type === 'assistant')!
    expect(b.message.content).toEqual(a.message.content)
    expect(b.message.usage).toEqual(a.message.usage)
  })

  test('running past the end of the script reports exhaustion, not a crash', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([{ text: 'only one' }])
    const msg = (await drain([assistant('only one')])).find(
      o => o.type === 'assistant',
    )!
    expect(msg.message.content[0].text).toContain('script exhausted')
    expect(msg.message.stop_reason).toBe('end_turn')
  })

  test('a missing script file yields an API error message, not a throw', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = '/nonexistent/faux.json'
    const out = await drain()
    expect(out).toHaveLength(1)
    expect(out[0]!.isApiErrorMessage).toBe(true)
    expect(out[0]!.message.content[0].text).toContain(
      'cannot load CLAUDE_CODE_FAUX_SCRIPT',
    )
  })

  test('a malformed script yields an API error message naming the problem', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile('{ not json')
    const out = await drain()
    expect(out[0]!.isApiErrorMessage).toBe(true)
  })

  test('with no script configured it still produces a valid turn', async () => {
    const msg = (await drain()).find(o => o.type === 'assistant')!
    expect(msg.message.content[0].text).toContain('script exhausted')
  })

  test('an aborted signal throws APIUserAbortError', async () => {
    process.env.CLAUDE_CODE_FAUX_SCRIPT = scriptFile([{ text: 'hi' }])
    const controller = new AbortController()
    controller.abort()
    const gen = queryModelFaux(
      [] as any,
      [] as any,
      [] as any,
      controller.signal,
      { model: 'faux-1' } as any,
    )
    await expect(gen.next()).rejects.toThrow()
  })
})
