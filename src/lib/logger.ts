import pino, { Logger, LoggerOptions } from 'pino';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getTradingMode } from './tradingMode';

/**
 * Structured logging core (Pino).
 *
 * Design goals for an autonomous trading backend:
 *   1. Machine-queryable JSON on stdout in production — the platform
 *      (Docker / systemd / any collector) ships the lines.
 *   2. Every log line carries service metadata: service, env, version,
 *      trading mode — so mixed-fleet deployments stay filterable.
 *   3. Secrets never reach stdout. DhanHQ access tokens, TOTP secrets,
 *      PINs, Authorization headers and cookies are redacted centrally.
 *   4. Request-scoped child loggers give every HTTP request a stable
 *      `requestId` that the frontend echoes via `x-request-id`.
 *   5. Pretty printing ONLY in development (pino-pretty), always to stdout.
 *   6. Every line ALSO lands in a daily-rotated JSONL file on disk
 *      (`logs/YYYY-MM-DD.jsonl`, same convention as local-agent-stack) —
 *      the terminal running the dev server is not the only place logs
 *      live, and a crash/restart (ts-node-dev --respawn) doesn't lose
 *      scrollback. The filename is fixed at process start, not rotated
 *      mid-run past midnight — restart the process to roll to a new file.
 *
 * Levels (Pino standard): fatal > error > warn > info > debug > trace.
 * EventBus levels (INFO/WARN/ERROR/SYSTEM/TRADE) map onto these —
 * see `busLevelToPino` in busLoggerBridge.
 */

const isDev = process.env.NODE_ENV !== 'production';

const LOG_DIR = process.env.LOG_DIR || path.resolve(__dirname, '../../logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.SERVICE_NAME ?? 'axis-nexus',
    env: process.env.NODE_ENV ?? 'development',
    version: process.env.GIT_SHA ?? process.env.APP_VERSION ?? 'dev',
    mode: getTradingMode(),
  },
  redact: {
    paths: [
      // Generic secrets
      'password', 'token', 'accessToken', 'refreshToken', 'secret',
      'authorization', 'cookie', 'apiKey', 'apiKeySecret', 'pin',
      // DhanHQ-specific credentials
      'dhanAccessToken', 'totpSecret', 'totp',
      // Nested wildcards
      '*.password', '*.token', '*.accessToken', '*.refreshToken',
      '*.secret', '*.authorization', '*.cookie', '*.pin',
      '*.dhanAccessToken', '*.totpSecret',
      // pino-http request serialization
      'req.headers.authorization', 'req.headers.cookie',
      'req.headers["x-api-key"]', 'req.headers["x-access-token"]',
      // Client log extras
      'events[*].token', 'events[*].password', 'extras.token', 'extras.password',
    ],
    censor: '[REDACTED]',
  },
  // ISO 8601 timestamps — time-zone safe (IST trading hours!), sortable.
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      // Raw JSON, always, to the daily file — the durable copy.
      { target: 'pino/file', level: 'trace', options: { destination: logFile, mkdir: true } },
      isDev
        ? { target: 'pino-pretty', level: 'trace', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname', singleLine: true } }
        // Prod: raw JSON to stdout too (fd 1) — the platform log collector ships these.
        : { target: 'pino/file', level: 'trace', options: { destination: 1 } },
    ],
  },
};

export const logger: Logger = pino(options);

/**
 * Per-module child logger (e.g. `moduleLogger('auth')` → { module: 'auth' }).
 * Use for long-lived subsystems: auth, db, ws, marketData, riskEngine...
 */
export function moduleLogger(module: string, extra: Record<string, unknown> = {}): Logger {
  return logger.child({ module, ...extra });
}

/**
 * Request-scoped logger factory. Accepts an upstream `requestId`
 * (frontend `x-request-id`) or generates one; OpenTelemetry trace/span
 * ids from a `traceparent` header are folded in when present so logs
 * and traces stay linkable without running a full OTel SDK.
 */
export function createRequestLogger(bindings: {
  requestId?: string;
  userId?: string | number | null;
  traceId?: string;
  spanId?: string;
  [key: string]: unknown;
}): Logger {
  return logger.child({
    requestId: bindings.requestId ?? randomUUID(),
    ...bindings,
  });
}

/** Normalizes any thrown value into a loggable error object with stack. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(typeof (err as any).code !== 'undefined' ? { code: (err as any).code } : {}),
      ...(typeof (err as any).status !== 'undefined' ? { status: (err as any).status } : {}),
    };
  }
  return { message: String(err) };
}

/** Logs a caught error with full context — the standard catch-block helper. */
export function logError(
  log: Logger,
  message: string,
  err: unknown,
  extra: Record<string, unknown> = {},
): void {
  log.error({ err: serializeError(err), ...extra }, message);
}

/** Parses a W3C `traceparent` header → { traceId, spanId } or null. */
export function parseTraceparent(header: unknown): { traceId: string; spanId: string } | null {
  if (typeof header !== 'string') return null;
  const m = header.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  return m ? { traceId: m[1], spanId: m[2] } : null;
}

export default logger;
