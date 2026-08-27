import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

type MemoryDebugFields = Record<
  string,
  boolean | number | string | null | undefined
>

const RSS_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024
const SAMPLE_INTERVAL_MS = 100
const RECORD_INTERVAL_MS = 500

let outputPath: string | undefined
let outputReady = false
let timer: ReturnType<typeof setInterval> | undefined
let lastRecordAt = 0
let thresholdRecorded = false

const metrics = new Map<string, number>()
const events = new Map<string, number>()
let lastEvent: { name: string; fields: MemoryDebugFields } | undefined

export function isMemoryDebugEnabled(): boolean {
  return process.env.CLAUDE_CODE_MEMORY_DEBUG === '1'
}

function getOutputPath(): string {
  return (
    process.env.CLAUDE_CODE_MEMORY_DEBUG_FILE ??
    join(tmpdir(), `ccb-memory-${process.pid}.jsonl`)
  )
}

function writeRecord(record: Record<string, unknown>): void {
  try {
    outputPath ??= getOutputPath()
    if (!outputReady) {
      mkdirSync(dirname(outputPath!), { recursive: true, mode: 0o700 })
      outputReady = true
    }
    appendFileSync(outputPath!, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {}
}

function snapshot(): Record<string, unknown> {
  return {
    metrics: Object.fromEntries(metrics),
    events: Object.fromEntries(events),
    lastEvent,
  }
}

export function memoryDebugAdd(name: string, value = 1): void {
  if (!isMemoryDebugEnabled()) return
  metrics.set(name, (metrics.get(name) ?? 0) + value)
}

export function memoryDebugSet(name: string, value: number): void {
  if (!isMemoryDebugEnabled()) return
  metrics.set(name, value)
}

export function memoryDebugMax(name: string, value: number): void {
  if (!isMemoryDebugEnabled()) return
  if (value > (metrics.get(name) ?? 0)) metrics.set(name, value)
}

export function memoryDebugEvent(
  name: string,
  fields: MemoryDebugFields = {},
): void {
  if (!isMemoryDebugEnabled()) return
  events.set(name, (events.get(name) ?? 0) + 1)
  lastEvent = { name, fields }
  writeRecord({
    type: 'event',
    pid: process.pid,
    timestamp: new Date().toISOString(),
    name,
    fields,
  })
}

export function startMemoryDebugMonitor(): void {
  if (!isMemoryDebugEnabled() || timer) return

  outputPath = getOutputPath()
  writeRecord({
    type: 'start',
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv,
    timestamp: new Date().toISOString(),
  })
  let lastRss = 0
  const sample = (): void => {
    const usage = process.memoryUsage()
    const now = Date.now()
    const crossed = usage.rss >= RSS_THRESHOLD_BYTES
    if (crossed && !thresholdRecorded) {
      thresholdRecorded = true
      writeRecord({
        type: 'threshold',
        pid: process.pid,
        timestamp: new Date(now).toISOString(),
        memoryUsage: usage,
        previousRss: lastRss,
        ...snapshot(),
      })
      process.stderr.write(
        `[memory-debug] RSS exceeded 2G: ${(usage.rss / 1024 / 1024 / 1024).toFixed(2)}G; log=${outputPath}\n`,
      )
    } else if (now - lastRecordAt >= RECORD_INTERVAL_MS) {
      lastRecordAt = now
      writeRecord({
        type: 'sample',
        pid: process.pid,
        timestamp: new Date(now).toISOString(),
        memoryUsage: usage,
        ...snapshot(),
      })
    }
    lastRss = usage.rss
  }

  sample()
  timer = setInterval(sample, SAMPLE_INTERVAL_MS)
  timer.unref?.()
}
