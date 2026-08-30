import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'

/**
 * Anthropic BigQuery metrics export is intentionally disabled in this build.
 * Customer-configured OpenTelemetry exporters are wired separately and are not
 * affected by this inert internal exporter.
 */
export class BigQueryMetricsExporter implements PushMetricExporter {
  constructor(_options: { readonly timeout?: number } = {}) {}

  export(
    _metrics: ResourceMetrics,
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

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA
  }
}
