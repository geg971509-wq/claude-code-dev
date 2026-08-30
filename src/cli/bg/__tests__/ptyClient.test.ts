import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachPtySession } from '../ptyClient.js'

const cleanupPaths: string[] = []
const cleanupServers: Server[] = []
const cleanupSockets: Socket[] = []

afterEach(async () => {
  process.stdin.pause()
  for (const socket of cleanupSockets.splice(0).reverse()) socket.destroy()
  for (const server of cleanupServers.splice(0).reverse())
    await new Promise<void>(resolve => server.close(() => resolve()))
  for (const path of cleanupPaths.splice(0).reverse())
    await rm(path, { recursive: true, force: true })
})

describe('attachPtySession', () => {
  test('detaches immediately even when the host keeps its write side open', async () => {
    process.stdin.pause()
    const dir = await mkdtemp(join(tmpdir(), 'claude-pty-client-'))
    const socketPath = join(dir, 'host.sock')
    const tokenPath = join(dir, 'host.token')
    cleanupPaths.push(dir)
    await writeFile(tokenPath, 'test-token\n', { mode: 0o600 })

    let accept: (socket: Socket) => void = () => {}
    const accepted = new Promise<Socket>(resolve => {
      accept = resolve
    })
    const server = createServer({ allowHalfOpen: true }, socket => {
      socket.on('error', () => {})
      const stream = setInterval(
        () => socket.write('{"type":"data","data":""}\n'),
        5,
      )
      socket.once('close', () => clearInterval(stream))
      accept(socket)
    })
    cleanupServers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    const baselineDataListeners = process.stdin.listenerCount('data')
    const attached = attachPtySession({
      pid: process.pid,
      sessionId: 'test-session',
      cwd: dir,
      startedAt: Date.now(),
      kind: 'bg',
      ptySocketPath: socketPath,
      ptyTokenPath: tokenPath,
    })
    cleanupSockets.push(await accepted)
    await Bun.sleep(10)
    process.stdin.emit('data', Buffer.from([0x1d]))

    const result = await Promise.race([
      attached.then(() => 'detached'),
      Bun.sleep(100).then(() => 'timed-out'),
    ])
    expect(result).toBe('detached')
    expect(process.stdin.listenerCount('data')).toBe(baselineDataListeners)
  })
})
