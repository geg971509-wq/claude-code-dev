import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs'

type FirstPartyEventLoggingExporterOptions = {
  readonly timeout?: number
  readonly maxBatchSize?: number
  readonly skipAuth?: boolean
  readonly batchDelayMs?: number
  readonly baseBackoffDelayMs?: number
  readonly maxBackoffDelayMs?: number
  readonly maxAttempts?: number
  readonly path?: string
  readonly baseUrl?: string
  readonly isKilled?: () => boolean
  readonly schedule?: (fn: () => Promise<void>, delayMs: number) => () => void
}

/**
 * First-party Anthropic event export is intentionally disabled in this build.
 * Keep the exporter shape so the existing OpenTelemetry wiring remains inert
 * without retaining any network, retry, or on-disk failed-event path.
 */
export class FirstPartyEventLoggingExporter implements LogRecordExporter {
  constructor(_options: FirstPartyEventLoggingExporterOptions = {}) {}

  export(
    _logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}
