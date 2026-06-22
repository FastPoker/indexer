/**
 * Prometheus metrics for the indexer. Scraped via GET /metrics.
 *
 * Conventions:
 *   - Names are snake_case with a `fastpoker_indexer_` prefix.
 *   - Label cardinality stays bounded — never label by wallet or signature.
 *
 * Wiring: register a default collector on startup, plus a few hand-rolled
 * counters/gauges. Bumps from domain code use the exported metric refs.
 */
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';

export const registry = new Registry();

// Node process metrics (CPU, memory, GC, event-loop lag, fd counts).
collectDefaultMetrics({ register: registry, prefix: 'fastpoker_indexer_' });

export const eventsApplied = new Counter({
  name: 'fastpoker_indexer_events_applied_total',
  help: 'Anchor events processed by handlers, by name.',
  labelNames: ['event'],
  registers: [registry],
});

export const eventApplyFailures = new Counter({
  name: 'fastpoker_indexer_event_apply_failures_total',
  help: 'Handler exceptions caught while processing events, by name.',
  labelNames: ['event'],
  registers: [registry],
});

export const httpRequests = new Counter({
  name: 'fastpoker_indexer_http_requests_total',
  help: 'HTTP requests served, by method+route+status_class.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'fastpoker_indexer_http_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const wsClients = new Gauge({
  name: 'fastpoker_indexer_ws_clients',
  help: 'Active WebSocket clients connected to /ws.',
  registers: [registry],
});

export const wsTopicSubscribers = new Gauge({
  name: 'fastpoker_indexer_ws_topic_subscribers',
  help: 'Subscribers per topic.',
  labelNames: ['topic'],
  registers: [registry],
});

export const wsBroadcast = new Counter({
  name: 'fastpoker_indexer_ws_broadcast_total',
  help: 'Update frames broadcast, by topic.',
  labelNames: ['topic'],
  registers: [registry],
});

export const cursorLagSlots = new Gauge({
  name: 'fastpoker_indexer_cursor_lag_slots',
  help: 'Slot delta between the latest seen slot and the cursor (lower = healthier).',
  registers: [registry],
});

export const laserStreamConnected = new Gauge({
  name: 'fastpoker_indexer_laserstream_connected',
  help: '1 when the LaserStream gRPC subscription is connected, 0 otherwise.',
  registers: [registry],
});

export const ingestedJackpotReceipts = new Counter({
  name: 'fastpoker_indexer_jackpot_receipts_ingested_total',
  help: 'JPV1 jackpot receipts persisted to Mongo.',
  registers: [registry],
});

/** Return the Prometheus text-format payload for GET /metrics. */
export async function getMetricsText(): Promise<string> {
  return registry.metrics();
}

export function getMetricsContentType(): string {
  return registry.contentType;
}
