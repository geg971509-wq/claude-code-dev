import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { createConnection } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { startPtyHost } from '../ptyHost.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('startPtyHost', () => {
  test('forwards authenticated input to the child PTY and streams output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-pty-host-'))
    const socketPath = join(dir, 'host.sock')
    const tokenPath = join(dir, 'host.token')
    const logPath = join(dir, 'host.log')
    const host = await startPtyHost({
      command: '/bin/sh',
      args: [
        '-lc',
        'IFS= read -r line; size=$(stty size); printf "reply:%s size:%s\\n" "$line" "$size"',
      ],
      cwd: dir,
      env: { ...process.env, TERM: 'xterm-256color' },
      socketPath,
      tokenPath,
      logPath,
    })
    cleanups.push(async () => {
      await host.close()
      await rm(dir, { recursive: true, force: true })
    })

    const token = (await readFile(tokenPath, 'utf8')).trim()
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
    const socket = createConnection(socketPath)
    cleanups.push(async () => {
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    const output = new Promise<string>((resolve, reject) => {
      let received = ''
      const timeout = setTimeout(
        () =>
          reject(new Error(`timed out waiting for PTY output: ${received}`)),
        1_500,
      )
      socket.on('data', chunk => {
        received += chunk.toString('utf8')
        if (!received.includes('reply:hello')) return
        clearTimeout(timeout)
        resolve(received)
      })
    })
    socket.write(`${JSON.stringify({ type: 'auth', token })}\n`)
    socket.write(`${JSON.stringify({ type: 'resize', cols: 100, rows: 40 })}\n`)
    socket.write(`${JSON.stringify({ type: 'input', data: 'hello\n' })}\n`)

    expect(await output).toContain('reply:hello')
    expect(await output).toContain('size:40 100')
  })
})
