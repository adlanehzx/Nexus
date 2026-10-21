import { metrics, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from "@opentelemetry/semantic-conventions";
import type { AppConfig } from "@nexus/config";

export interface TelemetryRuntime {
  shutdown(): Promise<void>;
}

/**
 * Initialise les fournisseurs globaux OpenTelemetry avant la construction de
 * l'application. Sans endpoint OTLP, les métriques Prometheus continuent de
 * fonctionner localement et aucune tentative réseau n'est faite.
 */
export function initializeTelemetry(config: AppConfig): TelemetryRuntime {
  const readers = config.METRICS_ENABLED
    ? [
        new PrometheusExporter({
          host: config.METRICS_HOST,
          port: config.METRICS_PORT,
          endpoint: "/metrics",
          withoutTargetInfo: false,
          withoutScopeInfo: false,
        }),
      ]
    : [];
  const traceExporter =
    config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? undefined
      : new OTLPTraceExporter({ url: traceEndpoint(config.OTEL_EXPORTER_OTLP_ENDPOINT) });

  const sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: config.API_VERSION,
        [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.NODE_ENV,
      }),
    ),
    metricReaders: readers,
    ...(traceExporter === undefined ? {} : { traceExporter }),
  });
  sdk.start();

  return { shutdown: () => sdk.shutdown() };
}

function traceEndpoint(base: string): string {
  const normalized = base.replace(/\/$/, "");
  return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
}

const meter = metrics.getMeter("nexus.api");
const tracer = trace.getTracer("nexus.api");

const httpRequests = meter.createCounter("nexus_http_requests", {
  description: "Nombre de requêtes HTTP terminées",
});
const httpDuration = meter.createHistogram("nexus_http_request_duration_seconds", {
  description: "Latence HTTP de bout en bout",
  unit: "s",
});

export function startHttpSpan(input: { method: string; route: string; correlationId: string }): {
  span: Span;
  startedAt: number;
} {
  const span = tracer.startSpan(`${input.method} ${input.route}`, {
    attributes: {
      "http.request.method": input.method,
      "http.route": input.route,
      "nexus.correlation_id": input.correlationId,
    },
  });
  return { span, startedAt: performance.now() };
}

export function finishHttpSpan(
  active: { span: Span; startedAt: number },
  input: { method: string; route: string; statusCode: number },
): void {
  const attributes = {
    method: input.method,
    route: input.route,
    status_code: String(input.statusCode),
  };
  httpRequests.add(1, attributes);
  httpDuration.record((performance.now() - active.startedAt) / 1_000, attributes);
  active.span.setAttribute("http.response.status_code", input.statusCode);
  if (input.statusCode >= 500) active.span.setStatus({ code: SpanStatusCode.ERROR });
  active.span.end();
}
