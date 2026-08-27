/**
 * Resolve file_uuid attachments on inbound bridge user messages.
 *
 * Web composer uploads via cookie-authed /api/{org}/upload, sends file_uuid
 * alongside the message. Here we fetch each via GET /api/oauth/files/{uuid}/content
 * (oauth-authed, same store), write to ~/.claude/uploads/{sessionId}/, and
 * return @path refs to prepend. Claude's Read tool takes it from there.
 *
 * Best-effort: any failure (no token, network, non-2xx, disk) logs debug and
 * skips that attachment. The message still reaches Claude, just without @path.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { z } from 'zod/v4'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { lazySchema } from '../utils/lazySchema.js'
import {
  MAX_PEER_FILE_BYTES,
  MAX_PEER_FILES,
} from '../utils/peerFileTransfer.js'
import { getBridgeAccessToken, getBridgeBaseUrl } from './bridgeConfig.js'

const DOWNLOAD_TIMEOUT_MS = 30_000

function debug(msg: string): void {
  logForDebugging(`[bridge:inbound-attach] ${msg}`)
}

const attachmentSchema = lazySchema(() =>
  z.object({
    file_uuid: z.string().min(1).max(256),
    file_name: z.string().min(1).max(1_024),
  }),
)
const attachmentsArraySchema = lazySchema(() => z.array(attachmentSchema()))

export type InboundAttachment = z.infer<ReturnType<typeof attachmentSchema>>

/** Pull file_attachments off a loosely-typed inbound message. */
export function extractInboundAttachments(msg: unknown): InboundAttachment[] {
  if (typeof msg !== 'object' || msg === null || !('file_attachments' in msg)) {
    return []
  }
  const parsed = attachmentsArraySchema().safeParse(msg.file_attachments)
  return parsed.success ? parsed.data.slice(0, MAX_PEER_FILES) : []
}

/**
 * Strip path components and keep only filename-safe chars. file_name comes
 * from the network (web composer), so treat it as untrusted even though the
 * composer controls it.
 */
function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || 'attachment'
}

function uploadsDir(): string {
  return join(getClaudeConfigHomeDir(), 'uploads', getSessionId())
}

/**
 * Fetch + write one attachment. Returns the absolute path on success,
 * undefined on any failure.
 */
type AttachmentBody = AsyncIterable<unknown> & { destroy?: () => void }

export async function readInboundAttachmentBytes(
  body: AttachmentBody,
  contentLength?: number,
): Promise<Buffer | undefined> {
  if (
    contentLength !== undefined &&
    (!Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_PEER_FILE_BYTES)
  ) {
    body.destroy?.()
    return undefined
  }

  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const value of body) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : undefined
      if (!chunk || total + chunk.length > MAX_PEER_FILE_BYTES) {
        body.destroy?.()
        return undefined
      }
      chunks.push(chunk)
      total += chunk.length
    }
  } catch {
    body.destroy?.()
    return undefined
  }
  return Buffer.concat(chunks, total)
}

function responseContentLength(headers: unknown): number | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined
  const source = headers as {
    get?: (name: string) => unknown
    'content-length'?: unknown
  }
  const value = source.get?.('content-length') ?? source['content-length']
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function downloadOne(
  att: InboundAttachment,
): Promise<Buffer | undefined> {
  const token = getBridgeAccessToken()
  if (!token) {
    debug('skip: no oauth token')
    return undefined
  }

  try {
    // getOauthConfig() (via getBridgeBaseUrl) throws on a non-allowlisted
    // CLAUDE_CODE_CUSTOM_OAUTH_URL — keep it inside the try so a bad
    // FedStart URL degrades to "no @path" instead of crashing print.ts's
    // reader loop (which has no catch around the await).
    const url = `${getBridgeBaseUrl()}/api/oauth/files/${encodeURIComponent(att.file_uuid)}/content`
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'stream',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MAX_PEER_FILE_BYTES,
      maxBodyLength: MAX_PEER_FILE_BYTES,
      validateStatus: () => true,
    })
    if (response.status !== 200) {
      const body = response.data as AttachmentBody | undefined
      body?.destroy?.()
      debug(`fetch ${att.file_uuid} failed: status=${response.status}`)
      return undefined
    }
    return await readInboundAttachmentBytes(
      response.data as AttachmentBody,
      responseContentLength(response.headers),
    )
  } catch (e) {
    debug(`fetch ${att.file_uuid} threw: ${e}`)
    return undefined
  }
}

async function persistOne(
  att: InboundAttachment,
  data: Buffer,
): Promise<string | undefined> {
  if (data.length > MAX_PEER_FILE_BYTES) return undefined
  const safeName = sanitizeFileName(att.file_name)
  const prefix = (
    att.file_uuid.slice(0, 8) || randomUUID().slice(0, 8)
  ).replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = uploadsDir()
  const outPath = join(dir, `${prefix}-${randomUUID().slice(0, 8)}-${safeName}`)

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(outPath, data, { mode: 0o600, flag: 'wx' })
  } catch (e) {
    await unlink(outPath).catch(() => undefined)
    debug(`write ${outPath} failed: ${e}`)
    return undefined
  }

  debug(`resolved ${att.file_uuid} → ${outPath} (${data.length} bytes)`)
  return outPath
}

type MaterializeOptions = {
  download?: (attachment: InboundAttachment) => Promise<Buffer | undefined>
  persist?: (
    attachment: InboundAttachment,
    data: Buffer,
  ) => Promise<string | undefined>
}

export async function materializeInboundAttachments(
  input: unknown,
  options: MaterializeOptions = {},
): Promise<{ prefix: string; paths: string[] }> {
  const parsed = attachmentsArraySchema().safeParse(input)
  if (!parsed.success || parsed.data.length === 0) {
    return { prefix: '', paths: [] }
  }
  const attachments = parsed.data.slice(0, MAX_PEER_FILES)
  const download = options.download ?? downloadOne
  const persist = options.persist ?? persistOne
  const paths: Array<string | undefined> = new Array(attachments.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, attachments.length) }, async () => {
      while (next < attachments.length) {
        const index = next++
        const attachment = attachments[index]!
        const data = await download(attachment)
        if (!data || data.length > MAX_PEER_FILE_BYTES) continue
        paths[index] = await persist(attachment, data)
      }
    }),
  )
  const resolved = paths.filter((path): path is string => path !== undefined)
  return {
    prefix:
      resolved.length > 0
        ? `${resolved.map(path => `@"${path}"`).join(' ')} `
        : '',
    paths: resolved,
  }
}

/**
 * Resolve all attachments on an inbound message to a prefix string of
 * @path refs. Empty string if none resolved.
 */
export async function resolveInboundAttachments(
  attachments: InboundAttachment[],
): Promise<string> {
  return (await materializeInboundAttachments(attachments)).prefix
}

/**
 * Prepend @path refs to content, whichever form it's in.
 * Targets the LAST text block — processUserInputBase reads inputString
 * from processedBlocks[processedBlocks.length - 1], so putting refs in
 * block[0] means they're silently ignored for [text, image] content.
 */
export function prependPathRefs(
  content: string | Array<ContentBlockParam>,
  prefix: string,
): string | Array<ContentBlockParam> {
  if (!prefix) return content
  if (typeof content === 'string') return prefix + content
  const i = content.findLastIndex(b => b.type === 'text')
  if (i !== -1) {
    const b = content[i]!
    if (b.type === 'text') {
      return [
        ...content.slice(0, i),
        { ...b, text: prefix + b.text },
        ...content.slice(i + 1),
      ]
    }
  }
  // No text block — append one at the end so it's last.
  return [...content, { type: 'text', text: prefix.trimEnd() }]
}

/**
 * Convenience: extract + resolve + prepend. No-op when the message has no
 * file_attachments field (fast path — no network, returns same reference).
 */
export async function resolveAndPrepend(
  msg: unknown,
  content: string | Array<ContentBlockParam>,
): Promise<string | Array<ContentBlockParam>> {
  const attachments = extractInboundAttachments(msg)
  if (attachments.length === 0) return content
  const prefix = await resolveInboundAttachments(attachments)
  return prependPathRefs(content, prefix)
}
