import { readdir, readFile, mkdir, chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { atomicWriteFile } from '../../utils/sessionStoragePortable.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import type { SessionEntry } from './engine.js'

/**
 * The on-disk job record is deliberately a small compatibility envelope.
 * Older dev builds wrote SessionEntry directly; the optional fields below let
 * those records continue to be listed and respawned while making launch mode
 * and routine identity explicit for new jobs.
 */
export type BgLaunch =
  | { mode: 'claude'; args: string[] }
  | { mode: 'exec'; command: string }

export type BgJobRecord = SessionEntry & {
  schemaVersion?: 1
  jobId?: string
  launch?: BgLaunch
  routine?: string
  intent?: string
  worktreePath?: string
  worktreeOwnershipToken?: string
  exitCode?: number | null
  error?: string
}

export type JobTargetError =
  | { kind: 'not-found'; target: string }
  | { kind: 'ambiguous'; target: string; matches: string[] }

export function getJobsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions', 'jobs')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSessionEntry(value: unknown): value is SessionEntry {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.pid === 'number' &&
    Number.isFinite(value.pid) &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    typeof value.kind === 'string'
  )
}

function normalizeJob(value: unknown): BgJobRecord | undefined {
  if (!isSessionEntry(value)) return undefined
  const sessionId = value.sessionId
  const jobId =
    typeof value.jobId === 'string' && value.jobId.length > 0
      ? value.jobId
      : sessionId.slice(0, 8)
  const args = Array.isArray(value.args)
    ? value.args.filter((arg): arg is string => typeof arg === 'string')
    : undefined
  const launch =
    isRecord(value.launch) &&
    value.launch.mode === 'exec' &&
    typeof value.launch.command === 'string'
      ? { mode: 'exec' as const, command: value.launch.command }
      : args
        ? { mode: 'claude' as const, args }
        : undefined
  return {
    ...value,
    schemaVersion: 1,
    jobId,
    ...(args ? { args } : {}),
    ...(launch ? { launch } : {}),
    ...(typeof value.routine === 'string' ? { routine: value.routine } : {}),
    ...(typeof value.intent === 'string' ? { intent: value.intent } : {}),
  }
}

/** Read all valid job records. Corrupt files are retained for recovery. */
export async function listJobRecords(): Promise<BgJobRecord[]> {
  let files: string[]
  try {
    files = await readdir(getJobsDir())
  } catch {
    return []
  }
  const jobs: BgJobRecord[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const job = normalizeJob(
        jsonParse(await readFile(join(getJobsDir(), file), 'utf8')),
      )
      if (job) jobs.push(job)
    } catch {
      // Keep malformed records in place so users can manually recover them.
    }
  }
  return jobs
}

/**
 * Resolve a CLI target using the reference's prefix semantics. PID and exact
 * display-name matching remain supported for backwards compatibility.
 */
export function resolveJobTarget(
  jobs: readonly BgJobRecord[],
  target: string,
): BgJobRecord | JobTargetError {
  const numericPid = /^\d+$/.test(target) ? Number(target) : Number.NaN
  const exact = jobs.filter(
    job =>
      job.jobId === target ||
      job.sessionId === target ||
      job.pid === numericPid ||
      job.name === target,
  )
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1)
    return {
      kind: 'ambiguous',
      target,
      matches: exact.map(job => job.jobId ?? job.sessionId),
    }

  const prefix = jobs.filter(
    job =>
      (job.jobId ?? '').startsWith(target) || job.sessionId.startsWith(target),
  )
  if (prefix.length === 1) return prefix[0]!
  if (prefix.length === 0) return { kind: 'not-found', target }
  return {
    kind: 'ambiguous',
    target,
    matches: prefix.map(job => job.jobId ?? job.sessionId),
  }
}

export function isJobTargetError(
  value: BgJobRecord | JobTargetError,
): value is JobTargetError {
  return (
    'kind' in value &&
    (value.kind === 'not-found' || value.kind === 'ambiguous')
  )
}

export function jobFilePath(job: Pick<BgJobRecord, 'sessionId'>): string {
  return join(getJobsDir(), `${job.sessionId}.json`)
}

export async function writeJobRecord(job: BgJobRecord): Promise<void> {
  const dir = getJobsDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  await atomicWriteFile(
    jobFilePath(job),
    jsonStringify({ ...job, schemaVersion: 1 }),
    {
      mode: 0o600,
    },
  )
}

export async function updateJobRecord(
  job: BgJobRecord,
  patch: Partial<BgJobRecord>,
): Promise<BgJobRecord> {
  const updated: BgJobRecord = {
    ...job,
    ...patch,
    schemaVersion: 1,
    updatedAt: Date.now(),
  }
  await writeJobRecord(updated)
  return updated
}

export async function removeJobRecord(
  job: Pick<BgJobRecord, 'sessionId'>,
): Promise<void> {
  try {
    await unlink(jobFilePath(job))
  } catch (error) {
    // A concurrent cleanup may have already removed the record. All other
    // failures must reach rmHandler so it does not report a false success.
    if (!isENOENT(error)) throw error
  }
}

export function formatJobTargetError(error: JobTargetError): string {
  if (error.kind === 'not-found') return `No job matching '${error.target}'`
  return `Ambiguous prefix '${error.target}', matches: ${error.matches.join(', ')}`
}
