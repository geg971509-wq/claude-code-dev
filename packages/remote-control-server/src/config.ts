import { error as logError } from './logger'

/**
 * Read a positive-integer setting, or fall back and say so.
 *
 * `parseInt` is the wrong tool here and a `|| fallback` guard does not rescue
 * it: `parseInt('1h', 10)` is 1, not NaN — it consumes the leading digits and
 * stops — so a natural-looking `RCS_JWT_EXPIRES_IN=1h` silently becomes a
 * one-second JWT lifetime, and the guard never fires because 1 is truthy. A
 * negative value passes for the same reason. `Number('1h')` is NaN, which is
 * what makes whole-string rejection possible.
 *
 * Misconfiguration is reported rather than absorbed: these values govern token
 * expiry and the dead-client reaper, where silently running on a default is how
 * a deployment ends up wrong in a way nobody notices. Logged rather than
 * thrown — this is an unattended container, and refusing to boot over one
 * stray env var is the worse failure.
 */
export function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logError(
      `[RCS] ${name}="${raw}" is not a positive integer; using ${fallback}. ` +
        `Use plain numbers without unit suffixes.`,
    )
    return fallback
  }
  return parsed
}

export const config = {
  version: process.env.RCS_VERSION || '0.1.0',
  port: readPositiveInt('RCS_PORT', 3000),
  host: process.env.RCS_HOST || '0.0.0.0',
  apiKeys: (process.env.RCS_API_KEYS || '').split(',').filter(Boolean),
  baseUrl: process.env.RCS_BASE_URL || '',
  pollTimeout: readPositiveInt('RCS_POLL_TIMEOUT', 8),
  heartbeatInterval: readPositiveInt('RCS_HEARTBEAT_INTERVAL', 20),
  jwtExpiresIn: readPositiveInt('RCS_JWT_EXPIRES_IN', 3600),
  disconnectTimeout: readPositiveInt('RCS_DISCONNECT_TIMEOUT', 300),
  webCorsOrigins: (process.env.RCS_WEB_CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
  /** Bun WebSocket idle timeout (seconds). Bun sends protocol-level pings after
   *  this many seconds of no received data. Must be shorter than any reverse
   *  proxy's idle timeout (nginx default 60s, Cloudflare 100s). Default 30s. */
  wsIdleTimeout: readPositiveInt('RCS_WS_IDLE_TIMEOUT', 30),
  /** Server→client keep_alive data-frame interval (seconds). Keeps reverse
   *  proxies from closing idle connections. Default 20s. */
  wsKeepaliveInterval: readPositiveInt('RCS_WS_KEEPALIVE_INTERVAL', 20),
} as const

export function getBaseUrl(): string {
  const url = config.baseUrl || `http://localhost:${config.port}`
  return url.replace(/\/+$/, '')
}
