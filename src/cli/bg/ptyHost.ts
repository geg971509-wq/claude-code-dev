import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rm, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { isENOENT } from '../../utils/errors.js'
import { atomicWriteFile } from '../../utils/sessionStoragePortable.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isPtyHostMessage, type PtyHostEvent } from './ptyProtocol.js'

export type PtyHostOptions = {
  readonly socketPath: string
  readonly tokenPath: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly logPath: string
}

export type PtyHostConfig = {
  readonly version: 1
  readonly readyPath: string
  readonly ackPath: string
  readonly options: PtyHostOptions
}

export type PtyHostHandle = {
  readonly pid: number
  readonly exited: Promise<{
    readonly code: number
    readonly signal: string | null
  }>
  close(): Promise<void>
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(item => typeof item === 'string')
  )
}

function parsePtyHostConfig(value: unknown): PtyHostConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('readyPath' in value) ||
    typeof value.readyPath !== 'string' ||
    !('ackPath' in value) ||
    typeof value.ackPath !== 'string' ||
    !('options' in value) ||
    typeof value.options !== 'object' ||
    value.options === null
  )
    throw new Error('Invalid PTY host configuration.')
  const options = value.options
  if (
    !('socketPath' in options) ||
    typeof options.socketPath !== 'string' ||
    !('tokenPath' in options) ||
    typeof options.tokenPath !== 'string' ||
    !('command' in options) ||
    typeof options.command !== 'string' ||
    !('args' in options) ||
    !Array.isArray(options.args) ||
    !options.args.every(item => typeof item === 'string') ||
    !('cwd' in options) ||
    typeof options.cwd !== 'string' ||
    !('env' in options) ||
    !isStringRecord(options.env) ||
    !('logPath' in options) ||
    typeof options.logPath !== 'string'
  )
    throw new Error('Invalid PTY host options.')
  return {
    version: 1,
    readyPath: value.readyPath,
    ackPath: value.ackPath,
    options: {
      socketPath: options.socketPath,
      tokenPath: options.tokenPath,
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      logPath: options.logPath,
    },
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

export async function startPtyHost(
  options: PtyHostOptions,
): Promise<PtyHostHandle> {
  const token = randomBytes(32).toString('hex')
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 })
  await mkdir(dirname(options.logPath), { recursive: true, mode: 0o700 })
  await rm(options.socketPath, { force: true })
  await atomicWriteFile(options.tokenPath, token, { mode: 0o600 })

  const clients = new Set<Socket>()
  const log = createWriteStream(options.logPath, { flags: 'a', mode: 0o600 })
  const decoder = new TextDecoder()
  let backlog = ''
  let exitEvent: PtyHostEvent | undefined
  let terminal: Bun.Terminal | undefined

  const broadcast = (event: PtyHostEvent) => {
    const line = `${jsonStringify(event)}\n`
    for (const client of clients) if (!client.destroyed) client.write(line)
  }
  const append = (data: Uint8Array<ArrayBuffer>) => {
    log.write(data)
    const text = decoder.decode(data, { stream: true })
    backlog = `${backlog}${text}`.slice(-256_000)
    broadcast({ type: 'data', data: text })
  }

  const childTerminal = new Bun.Terminal({
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
    data: (_pty, data) => append(data),
  })
  terminal = childTerminal
  const child = Bun.spawn([options.command, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    terminal: childTerminal,
  })

  const server = createServer(socket => {
    clients.add(socket)
    let authenticated = false
    let pending = ''
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
        } catch {
          socket.destroy()
          return
        }
        if (!isPtyHostMessage(value)) {
          socket.destroy()
          return
        }
        if (value.type === 'auth') {
          const left = Buffer.from(value.token)
          const right = Buffer.from(token)
          authenticated =
            left.length === right.length && timingSafeEqual(left, right)
          if (!authenticated) {
            socket.destroy()
            return
          }
          socket.write(
            `${jsonStringify({ type: 'live', sessionId: options.env.CLAUDE_CODE_SESSION_ID ?? '' })}\n`,
          )
          if (backlog)
            socket.write(`${jsonStringify({ type: 'data', data: backlog })}\n`)
          if (exitEvent) socket.write(`${jsonStringify(exitEvent)}\n`)
          continue
        }
        if (!authenticated) {
          socket.destroy()
          return
        }
        switch (value.type) {
          case 'input':
            terminal?.write(value.data)
            break
          case 'resize':
            terminal?.resize(value.cols, value.rows)
            break
          case 'kill':
            child.kill(value.signal ?? 'SIGTERM')
            break
          case 'ping':
            socket.write(`${jsonStringify({ type: 'pong' })}\n`)
            break
        }
      }
    })
    socket.on('close', () => clients.delete(socket))
  })
  await listen(server, options.socketPath)
  await chmod(options.socketPath, 0o600)

  const exited = child.exited.then(code => {
    exitEvent = {
      type: 'exit',
      code,
      signal: child.signalCode ?? null,
    }
    broadcast(exitEvent)
    return { code, signal: child.signalCode ?? null }
  })
  let closed = false
  return {
    pid: child.pid,
    exited,
    async close() {
      if (closed) return
      closed = true
      if (!child.killed) child.kill('SIGTERM')
      await exited
      for (const client of clients) client.destroy()
      await closeServer(server)
      terminal?.close()
      terminal = undefined
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        log.once('error', onError)
        log.end(() => {
          log.off('error', onError)
          resolve()
        })
      })
      await Promise.all([
        rm(options.socketPath, { force: true }),
        rm(options.tokenPath, { force: true }),
      ])
    },
  }
}

export async function runPtyHostFromConfig(
  configPath: string,
): Promise<number> {
  let config: PtyHostConfig
  try {
    config = parsePtyHostConfig(JSON.parse(await readFile(configPath, 'utf8')))
  } finally {
    await unlink(configPath).catch(error => {
      if (!isENOENT(error)) throw error
    })
  }
  const host = await startPtyHost(config.options)
  await atomicWriteFile(config.readyPath, jsonStringify({ pid: host.pid }), {
    mode: 0o600,
  })
  const shutdown = () => void host.close()
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  try {
    return (await host.exited).code
  } finally {
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
    await Bun.sleep(10)
    await host.close()
    const deadline = Date.now() + 10_000
    while (!(await Bun.file(config.ackPath).exists()) && Date.now() < deadline)
      await Bun.sleep(25)
    await rm(dirname(config.options.socketPath), {
      recursive: true,
      force: true,
    })
  }
}
