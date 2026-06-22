/**
 * Shared pino logger. JSON output to stdout in production, pretty-printed in
 * dev. Replaces ad-hoc `console.log` / `console.warn` / `console.error`
 * across the service so log shippers (Vector, Filebeat, Loki agent) can
 * parse and route by level/component.
 *
 * Conventions:
 *   - One logger per module via `log.child({ component: '...' })`.
 *   - Always include structured fields, not interpolated strings:
 *       log.error({ err, sig }, 'handler failed')
 *     NOT:
 *       log.error(`handler failed: ${sig}: ${err}`)
 *   - Reserve `error` for things that should page someone. `warn` for
 *     "we degraded but kept serving", `info` for state transitions,
 *     `debug` for trace-level detail (off in prod).
 */
import { pino } from 'pino';

// JSON to stdout in all environments. If you want pretty output locally,
// pipe through `pino-pretty` from the command line:
//   npm start | npx pino-pretty
// Embedding the pretty transport here adds a peer dep on pino-pretty that
// crashes the process if not installed; better to keep the runtime lean.
export const log = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: {
    service: 'fastpoker-indexer',
    pid: process.pid,
  },
  redact: {
    paths: ['*.apiKey', '*.api_key', '*.token', '*.secret', '*.privateKey'],
    censor: '[redacted]',
  },
});
