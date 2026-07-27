import { Hono } from 'hono'
import {
  resolveExistingWebSessionId,
  resolveOwnedWebSessionId,
  toWebSessionId,
} from '../../services/session'

const app = new Hono()

/** POST /web/bind — Bind a session to a UUID (no-login auth) */
app.post('/bind', async c => {
  const body = await c.req.json()
  const sessionId = body.sessionId
  // UUID can come from query param (api.js sends it in URL) or body
  const uuid = c.req.query('uuid') || body.uuid

  if (!sessionId || !uuid) {
    return c.json({ error: 'sessionId and uuid are required' }, 400)
  }

  const resolvedSessionId = resolveExistingWebSessionId(sessionId)
  if (!resolvedSessionId) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const ownedSessionId = resolveOwnedWebSessionId(resolvedSessionId, uuid)
  if (!ownedSessionId) {
    return c.json({ error: 'Session already bound' }, 403)
  }

  return c.json({ ok: true, sessionId: toWebSessionId(ownedSessionId) })
})

export default app
