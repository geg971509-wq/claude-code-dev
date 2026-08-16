import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { ProcessManager } from './manager.js'
import { createApp } from './routes.js'

export async function startManager(
  port: number,
  hostname = '127.0.0.1',
): Promise<void> {
  const manager = new ProcessManager()
  const app = createApp(manager)

  // Health check
  app.get('/health', c => c.json({ status: 'ok' }))

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('Shutting down...')
    await manager.shutdownAll()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  const bindHost = hostname === 'localhost' ? '127.0.0.1' : hostname
  const server = serve({ fetch: app.fetch, port, hostname: bindHost })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  Error: port ${port} is already in use. Use --port to specify a different port.\n`,
      )
    } else {
      console.error(`\n  Error: ${err.message}\n`)
    }
    process.exit(1)
  })

  console.log()
  console.log(`  🖥️  ACP Manager`)
  console.log()
  console.log(`    URL:   http://${bindHost}:${port}`)
  console.log()
  console.log(`  Press Ctrl+C to stop`)
  console.log()

  // Keep running
  await new Promise(() => {})
}
