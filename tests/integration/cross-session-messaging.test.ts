import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'crypto'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '../..')
const RUNNER = resolve(import.meta.dir, 'fixtures/cross-session-peer.runner.ts')

type Reply = {
  id?: number
  ready?: boolean
  ok?: boolean
  result?: any
  error?: string
}

class PeerProcess {
  readonly process: ReturnType<typeof Bun.spawn>
  #nextId = 1
  #pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >()
  #ready: Promise<void>

  constructor(args: string[], configDir: string) {
    let readyResolve!: () => void
    this.#ready = new Promise(resolveReady => {
      readyResolve = resolveReady
    })
    this.process = Bun.spawn({
      cmd: [
        process.execPath,
        '--feature',
        'CROSS_SESSION_MESSAGING',
        '--feature',
        'BG_SESSIONS',
        RUNNER,
        ...args,
      ],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        NO_COLOR: '1',
        NODE_ENV: 'test',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    void this.#readLines(readyResolve)
  }

  async #readLines(readyResolve: () => void): Promise<void> {
    const reader = this.process.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('{')) continue
        const reply = JSON.parse(line) as Reply
        if (reply.ready) {
          readyResolve()
          continue
        }
        if (reply.id === undefined) continue
        const pending = this.#pending.get(reply.id)
        if (!pending) continue
        this.#pending.delete(reply.id)
        if (reply.ok) pending.resolve(reply)
        else pending.reject(new Error(reply.error ?? 'peer command failed'))
      }
    }
  }

  ready(): Promise<void> {
    return this.#ready
  }

  command(command: Record<string, unknown>): Promise<Reply> {
    const id = this.#nextId++
    return new Promise((resolveReply, reject) => {
      this.#pending.set(id, { resolve: resolveReply, reject })
      this.process.stdin.write(`${JSON.stringify({ id, ...command })}\n`)
      this.process.stdin.flush()
    })
  }

  async stop(): Promise<void> {
    if (this.process.exitCode !== null) return
    await this.command({ type: 'stop' }).catch(() => undefined)
    await this.process.exited
  }
}

let tempDir: string | undefined
const peers: PeerProcess[] = []

afterEach(async () => {
  await Promise.all(peers.splice(0).map(peer => peer.stop()))
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error('Timed out waiting for cross-session state')
}

describe('cross-session messaging production flow', () => {
  test('two sessions exchange held approval, receipt, and verified attachment exactly once', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cross-session-e2e-'))
    const configDir = join(tempDir, 'config')
    const senderSocket = join(tempDir, 'sender.sock')
    const receiverSocket = join(tempDir, 'receiver.sock')
    const senderSessionId = randomUUID()
    const receiverSessionId = randomUUID()
    const sender = new PeerProcess(
      [senderSocket, 'default', senderSessionId, 'sender'],
      configDir,
    )
    const receiver = new PeerProcess(
      [receiverSocket, 'bypassPermissions', receiverSessionId, 'receiver'],
      configDir,
    )
    peers.push(sender, receiver)
    await Promise.all([sender.ready(), receiver.ready()])

    const roster = (await sender.command({ type: 'list' })).result
    expect(roster.data.listing).toContain('receiver')
    expect(roster.data.listing).toMatch(/\buds\b.*reachable/)

    const message = await sender.command({
      type: 'send-tool',
      target: 'receiver',
      content: 'review the attached payload',
    })
    expect(message.result.data).toMatchObject({
      success: true,
      status: 'held',
    })
    const messageId = message.result.data.msg_id as string

    const messageHeld = (await receiver.command({ type: 'snapshot' })).result
    expect(messageHeld.held).toHaveLength(1)
    expect(messageHeld.queued).toHaveLength(0)
    expect(
      (await receiver.command({ type: 'approve', msgId: messageId })).result,
    ).toBe('delivered')

    const sourcePath = join(tempDir, 'payload.txt')
    const source = Buffer.from('cross-session attachment bytes\n')
    await writeFile(sourcePath, source)
    const sent = await sender.command({
      type: 'send-file-tool',
      target: 'receiver',
      path: sourcePath,
      content: 'attachment follows',
    })
    expect(sent.result.data).toMatchObject({ success: true })
    const msgId = sent.result.data.msg_id as string

    const before = (await receiver.command({ type: 'snapshot' })).result
    expect(before.held).toHaveLength(1)
    expect(before.queued).toHaveLength(1)

    expect((await receiver.command({ type: 'approve', msgId })).result).toBe(
      'delivered',
    )
    await waitFor(async () => {
      const snapshot = (await sender.command({ type: 'snapshot' })).result
      return snapshot.receipts.some(
        (receipt: { msgId: string; status: string }) =>
          receipt.msgId === msgId && receipt.status === 'delivered',
      )
    })

    const after = (await receiver.command({ type: 'snapshot' })).result
    expect(after.held).toHaveLength(0)
    expect(after.queued).toHaveLength(2)
    const attachmentMessage = after.queued.find(
      (entry: { origin?: { attachmentPaths?: string[] } }) =>
        entry.origin?.attachmentPaths?.length,
    )
    expect(attachmentMessage.value).toContain('attachment follows')
    const [attachmentPath] = attachmentMessage.origin
      .attachmentPaths as string[]
    const received = await readFile(attachmentPath)
    expect(received).toEqual(source)
    expect(createHash('sha256').update(received).digest('hex')).toBe(
      createHash('sha256').update(source).digest('hex'),
    )

    await sender.command({
      type: 'send',
      target: `uds:${receiverSocket}`,
      content: 'duplicate must not enqueue',
      msgId,
      fromMode: 'prompting',
      targetSessionId: receiverSessionId,
    })
    expect(
      (await receiver.command({ type: 'snapshot' })).result.queued,
    ).toHaveLength(2)
  }, 20_000)
})
