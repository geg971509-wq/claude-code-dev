import { readFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import type { SessionEntry } from './engine.js'
import { isPtyHostEvent } from './ptyProtocol.js'

function connect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
}

export async function attachPtySession(session: SessionEntry): Promise<void> {
  if (!session.ptySocketPath || !session.ptyTokenPath)
    throw new Error(`Session ${session.sessionId} has no PTY control socket.`)
  const token = (await readFile(session.ptyTokenPath, 'utf8')).trim()
  const socket = createConnection(session.ptySocketPath)
  await connect(socket)

  const send = (message: object) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
  }
  send({ type: 'auth', token })
  const resize = () => {
    if (!process.stdout.columns || !process.stdout.rows) return
    send({
      type: 'resize',
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    })
  }
  const onInput = (data: Buffer) => {
    if (data.includes(0x1d)) {
      socket.destroy()
      return
    }
    send({ type: 'input', data: data.toString('utf8') })
  }

  const wasRaw = process.stdin.isRaw
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', onInput)
  process.stdout.on('resize', resize)
  resize()
  process.stderr.write('Attached. Press Ctrl-] to detach.\n')
  const heartbeat = setInterval(() => send({ type: 'ping' }), 15_000)

  try {
    await new Promise<void>((resolve, reject) => {
      let pending = ''
      let exited = false
      socket.on('data', data => {
        pending += data.toString('utf8')
        for (;;) {
          const newline = pending.indexOf('\n')
          if (newline < 0) break
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (!line) continue
          let value: unknown
          try {
            value = JSON.parse(line)
          } catch (error) {
            reject(error)
            return
          }
          if (!isPtyHostEvent(value)) {
            reject(new Error('PTY host returned an invalid event.'))
            return
          }
          if (value.type === 'data') process.stdout.write(value.data)
          if (value.type === 'exit') {
            exited = true
            resolve()
          }
        }
      })
      socket.once('error', reject)
      socket.once('close', () => {
        if (!exited) resolve()
      })
    })
  } finally {
    clearInterval(heartbeat)
    process.stdin.off('data', onInput)
    process.stdout.off('resize', resize)
    if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw))
    process.stdin.pause()
    socket.destroy()
  }
}
