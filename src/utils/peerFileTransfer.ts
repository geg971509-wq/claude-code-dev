import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import { getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'

export const MAX_PEER_FILE_BYTES = 30 * 1024 * 1024
export const MAX_PEER_FILES = 16
const STALE_SPOOL_MS = 24 * 60 * 60 * 1000
const SHA256 = /^[0-9a-f]{64}$/

export type LocalPeerFile = {
  path: string
  file_name: string
  file_size: number
  sha256: string
  media_type: string
}

function peerTransferSpoolDir(): string {
  return join(getClaudeConfigHomeDir(), 'file-transfers')
}

function peerUploadsDir(sessionId: string): string {
  return join(getClaudeConfigHomeDir(), 'uploads', sessionId)
}

export function sanitizePeerFileName(name: string): string {
  const safe = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment'
  const dot = safe.lastIndexOf('.')
  const extension = dot > 0 && safe.length - dot <= 16 ? safe.slice(dot) : ''
  const stem = extension ? safe.slice(0, dot) : safe
  return stem.slice(0, 200 - extension.length) + extension
}

export function peerFileMediaType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    case '.json':
      return 'application/json'
    case '.txt':
    case '.md':
      return 'text/plain'
    default:
      return 'application/octet-stream'
  }
}

export async function readPeerFileBounded(
  path: string,
  maxBytes = MAX_PEER_FILE_BYTES,
): Promise<Buffer | undefined> {
  try {
    const before = await stat(path)
    if (!before.isFile() || before.size > maxBytes) return undefined
    const handle = await open(path, 'r')
    try {
      const after = await handle.stat()
      if (!after.isFile() || after.size > maxBytes) return undefined
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

export async function stageLocalPeerFile(path: string): Promise<LocalPeerFile> {
  const bytes = await readPeerFileBounded(path)
  if (!bytes) throw new Error('source unreadable or over the 30 MB size limit')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const dir = peerTransferSpoolDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const fileName = basename(path)
  const target = join(
    dir,
    `${sha256.slice(0, 8)}-${randomUUID().slice(0, 8)}-${sanitizePeerFileName(fileName)}`,
  )
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
  return {
    path: target,
    file_name: fileName,
    file_size: bytes.length,
    sha256,
    media_type: peerFileMediaType(fileName),
  }
}

function isLocalPeerFile(value: unknown): value is LocalPeerFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Partial<LocalPeerFile>
  return (
    typeof file.path === 'string' &&
    typeof file.file_name === 'string' &&
    typeof file.file_size === 'number' &&
    Number.isSafeInteger(file.file_size) &&
    file.file_size >= 0 &&
    typeof file.sha256 === 'string' &&
    SHA256.test(file.sha256) &&
    typeof file.media_type === 'string'
  )
}

function failure(name: string, reason: string): string {
  return `[SendFile: "${sanitizePeerFileName(name)}" was not delivered - ${reason}]`
}

export async function materializeLocalPeerFiles(
  input: unknown,
  sessionId: string = getSessionId(),
): Promise<{
  prefix: string
  received: number
  verified: number
  paths: string[]
}> {
  if (!Array.isArray(input) || !input.every(isLocalPeerFile)) {
    return { prefix: '', received: 0, verified: 0, paths: [] }
  }
  const notes: string[] = []
  const files = input.slice(0, MAX_PEER_FILES)
  if (input.length > MAX_PEER_FILES) {
    notes.push(
      `[SendFile: ${input.length - MAX_PEER_FILES} additional attachment(s) were dropped - max ${MAX_PEER_FILES} per message]`,
    )
  }

  const spool = resolve(peerTransferSpoolDir())
  const uploads = peerUploadsDir(sessionId)
  const paths: string[] = []
  for (const file of files) {
    const source = resolve(file.path)
    if (!isAbsolute(file.path) || dirname(source) !== spool) {
      notes.push(failure(file.file_name, 'transfer path is outside the spool'))
      continue
    }
    try {
      const dirInfo = await lstat(spool)
      const fileInfo = await lstat(source)
      if (
        !dirInfo.isDirectory() ||
        dirInfo.isSymbolicLink() ||
        !fileInfo.isFile() ||
        fileInfo.isSymbolicLink()
      ) {
        notes.push(
          failure(file.file_name, 'transfer copy is not a regular file'),
        )
        continue
      }
    } catch {
      notes.push(failure(file.file_name, 'transfer copy is unavailable'))
      continue
    }

    const bytes = await readPeerFileBounded(source)
    if (!bytes) {
      notes.push(failure(file.file_name, 'transfer copy is unavailable'))
      continue
    }
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== file.file_size || hash !== file.sha256) {
      notes.push(failure(file.file_name, 'integrity verification failed'))
      continue
    }

    await mkdir(uploads, { recursive: true, mode: 0o700 })
    const target = join(
      uploads,
      `${hash.slice(0, 8)}-${randomUUID().slice(0, 8)}-${sanitizePeerFileName(file.file_name)}`,
    )
    try {
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
      paths.push(target)
      await unlink(source).catch(() => undefined)
    } catch {
      notes.push(failure(file.file_name, 'could not write the uploads copy'))
    }
  }

  const refs = paths.map(path => `@"${path}"`)
  const prefixParts = [...refs, ...notes]
  return {
    prefix: prefixParts.length > 0 ? `${prefixParts.join(' ')} ` : '',
    received: files.length,
    verified: paths.length,
    paths,
  }
}

export async function sweepStalePeerFileTransfers(): Promise<void> {
  const dir = peerTransferSpoolDir()
  try {
    const cutoff = Date.now() - STALE_SPOOL_MS
    for (const name of (await readdir(dir)).slice(0, 200)) {
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.isFile() && info.mtimeMs < cutoff) await unlink(path)
      } catch {
        // Best-effort cleanup.
      }
    }
  } catch {
    // Spool does not exist yet.
  }
}
