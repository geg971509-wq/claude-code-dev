import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { ExportResultCode } from '@opentelemetry/core'
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import axios from 'axios'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId } from '../../../bootstrap/state.js'
import * as metricsOptOut from '../../api/metricsOptOut.js'
import { FirstPartyEventLoggingExporter } from '../firstPartyEventLoggingExporter.js'
import {
  initialize1PEventLogging,
  is1PEventLoggingEnabled,
  logEventTo1P,
} from '../firstPartyEventLogger.js'
import {
  initializeTelemetry,
  flushTelemetry,
} from '../../../utils/telemetry/instrumentation.js'
import { BigQueryMetricsExporter } from '../../../utils/telemetry/bigqueryExporter.js'

const ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'BETA_TRACING_ENDPOINT',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
] as const

const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
)
const runtime = globalThis as unknown as {
  MACRO?: { VERSION: string }
}
const originalMacro = runtime.MACRO

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (originalMacro === undefined) delete runtime.MACRO
  else runtime.MACRO = originalMacro
})

describe('telemetry privacy boundaries', () => {
  test('keeps first-party event logging disabled despite explicit opt-in', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-no-telemetry-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    let emitted = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      emitted = true
      throw new Error('first-party telemetry request')
    }) as unknown as typeof fetch

    try {
      initialize1PEventLogging()
      logEventTo1P('tengu_api_query', { model: 1 })
      expect(is1PEventLoggingEnabled()).toBe(false)
      expect(emitted).toBe(false)
      expect(await readdir(configDir)).not.toContain('telemetry')
    } finally {
      globalThis.fetch = originalFetch
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('keeps the first-party exporter inert even when constructed directly', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-no-1p-exporter-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    const telemetryDir = join(configDir, 'telemetry')
    await mkdir(telemetryDir, { recursive: true })
    const queuedFile = join(
      telemetryDir,
      `1p_failed_events.${getSessionId()}.previous.json`,
    )
    const queuedEvent =
      '{"event_type":"ClaudeCodeInternalEvent","event_data":{}}\n'
    await writeFile(queuedFile, queuedEvent, 'utf8')
    const post = spyOn(axios, 'post').mockRejectedValue(
      new Error('first-party telemetry request'),
    )
    const results: number[] = []
    const logRecord: ReadableLogRecord = {
      hrTime: [1, 0],
      hrTimeObserved: [1, 0],
      resource: resourceFromAttributes({}),
      instrumentationScope: { name: 'com.anthropic.claude_code.events' },
      attributes: { event_name: 'tengu_api_query' },
      body: 'tengu_api_query',
      droppedAttributesCount: 0,
    }

    try {
      const exporter = new FirstPartyEventLoggingExporter()
      await exporter.export([logRecord], result => results.push(result.code))
      await exporter.forceFlush()

      expect(post).toHaveBeenCalledTimes(0)
      expect(results).toEqual([ExportResultCode.SUCCESS])
      expect(await readFile(queuedFile, 'utf8')).toBe(queuedEvent)
    } finally {
      post.mockRestore()
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('keeps the BigQuery exporter inert even when called directly', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const metricsEnabled = spyOn(
      metricsOptOut,
      'checkMetricsEnabled',
    ).mockResolvedValue({
      enabled: true,
      hasError: false,
    })
    const post = spyOn(axios, 'post').mockResolvedValue({ data: { ok: true } })
    const results: number[] = []
    const metrics: ResourceMetrics = {
      resource: resourceFromAttributes({}),
      scopeMetrics: [],
    }

    try {
      const exporter = new BigQueryMetricsExporter()
      await exporter.export(metrics, result => results.push(result.code))
      await exporter.forceFlush()

      expect(post).toHaveBeenCalledTimes(0)
      expect(results).toEqual([ExportResultCode.SUCCESS])
    } finally {
      post.mockRestore()
      metricsEnabled.mockRestore()
    }
  })

  test('does not initialize the BigQuery exporter when customer telemetry is enabled', async () => {
    runtime.MACRO = { VERSION: 'test' }
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    process.env.OTEL_METRICS_EXPORTER = 'none'
    process.env.OTEL_LOGS_EXPORTER = 'none'
    process.env.OTEL_TRACES_EXPORTER = 'none'
    let requests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      requests += 1
      throw new Error('Anthropic telemetry request')
    }) as unknown as typeof fetch

    try {
      await initializeTelemetry()
      await flushTelemetry()
      expect(requests).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
