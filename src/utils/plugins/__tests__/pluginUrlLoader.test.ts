import { afterEach, describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import { createServer } from 'node:http'
import { runCleanupFunctions } from '../../cleanupRegistry.js'
import { pathExists } from '../../file.js'
import { loadPluginsFromUrls } from '../pluginLoader.js'
import {
  cleanupSessionPluginCache,
  resetSessionPluginCache,
} from '../zipCache.js'

describe('loadPluginsFromUrls', () => {
  afterEach(async () => {
    await cleanupSessionPluginCache()
    resetSessionPluginCache()
  })

  test('loads valid archives while preserving per-URL failures and cleans up on shutdown', async () => {
    // Given
    const archive = zipSync({
      'url-plugin/.claude-plugin/plugin.json': new TextEncoder().encode(
        JSON.stringify({ name: 'url-plugin', description: 'From URL' }),
      ),
      'url-plugin/commands/hello.md': new TextEncoder().encode('# Hello'),
    })
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === '/plugin.zip'
          ? new Response(Buffer.from(archive))
          : new Response('missing', { status: 404 })
      },
    })

    try {
      // When
      const result = await loadPluginsFromUrls([
        `${server.url}missing.zip`,
        `${server.url}plugin.zip`,
      ])

      // Then
      expect(result.plugins.map(plugin => plugin.name)).toEqual(['url-plugin'])
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.source).toBe('plugin-url[0]')
      expect(await pathExists(result.plugins[0]?.path ?? '')).toBe(true)

      await runCleanupFunctions()
      expect(await pathExists(result.plugins[0]?.path ?? '')).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('rejects archives whose declared size exceeds the official limit', async () => {
    // Given
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Length': String(256 * 1024 * 1024 + 1),
      })
      response.end('oversized')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected an HTTP server address')
    }

    try {
      // When
      const result = await loadPluginsFromUrls([
        `http://127.0.0.1:${address.port}/plugin.zip`,
      ])

      // Then
      expect(result.plugins).toEqual([])
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatchObject({
        type: 'generic-error',
        error: expect.stringContaining('Plugin archive too large'),
      })
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
})
